import * as crypto from 'crypto';

import {
  GuanjiaCreditLedgerRecord,
  GuanjiaModelProvider,
  PrepayReservation,
} from './types';

export interface InvokeModelRequest {
  userId: string;
  shopId: string;
  model: string;
  prompt: string;
  estimatedMaxTokens?: number;
  customEstimatedCredits?: number;
}

export interface InvokeModelResponse {
  success: boolean;
  content?: string;
  providerId?: string;
  model?: string;
  reservationId: string;
  estimatedCredits: number;
  actualCredits: number;
  refundCredits: number;
  actualCost: number;
  error?: string;
}

export class GuanjiaModelRouter {
  private static instance: GuanjiaModelRouter | null = null;

  // 统一单一余额账本（按用户/门店）
  private userBalances: Map<string, { available: number; reserved: number; totalUsed: number }> = new Map();

  // 多模型来源池配置
  private providers: Map<string, GuanjiaModelProvider> = new Map();

  // 预扣挂账表
  private reservations: Map<string, PrepayReservation> = new Map();

  // 详细记账台账
  private ledger: GuanjiaCreditLedgerRecord[] = [];

  private constructor() {
    this.initDefaultProviders();
  }

  public static getInstance(): GuanjiaModelRouter {
    if (!GuanjiaModelRouter.instance) {
      GuanjiaModelRouter.instance = new GuanjiaModelRouter();
    }
    return GuanjiaModelRouter.instance;
  }

  private initDefaultProviders(): void {
    // 1. 自有模型池 (主来源，成本低)
    this.registerProvider({
      id: 'provider-self-hosted',
      name: '自有算力池',
      baseUrl: 'https://api.guanjia.internal/v1',
      apiKey: 'sk-guanjia-self-default',
      models: ['guanjia-fast', 'guanjia-pro', 'gpt-4o-mini', 'claude-3-5-sonnet'],
      priority: 1,
      enabled: true,
      protocol: 'openai',
      costPer1kTokens: 0.005, // 0.005元/千Token
      rateMultiplier: 1.0, // 1 Token = 1 积分折算
    });

    // 2. 官方聚合池 (备用来源，可用性高)
    this.registerProvider({
      id: 'provider-lobster-official',
      name: 'LobsterAI 官方聚合池',
      baseUrl: 'https://api.lobsterai.com/v1',
      apiKey: 'sk-lobster-official-fallback',
      models: ['guanjia-fast', 'guanjia-pro', 'gpt-4o-mini', 'claude-3-5-sonnet'],
      priority: 2,
      enabled: true,
      protocol: 'openai',
      costPer1kTokens: 0.015,
      rateMultiplier: 1.0,
    });
  }

  public registerProvider(provider: GuanjiaModelProvider): void {
    this.providers.set(provider.id, { ...provider });
  }

  public listProviders(): GuanjiaModelProvider[] {
    return Array.from(this.providers.values()).sort((a, b) => a.priority - b.priority);
  }

  public setProviderEnabled(providerId: string, enabled: boolean): boolean {
    const p = this.providers.get(providerId);
    if (p) {
      p.enabled = enabled;
      return true;
    }
    return false;
  }

  // =========================================================================
  // 单一积分余额管理 (对外只展示这一个数字)
  // =========================================================================
  private getAccountKey(userId: string, shopId: string): string {
    return `${shopId || 'default'}:${userId || 'anonymous'}`;
  }

  public getBalance(userId: string, shopId: string): { available: number; reserved: number; totalUsed: number } {
    const key = this.getAccountKey(userId, shopId);
    const current = this.userBalances.get(key);
    if (!current) {
      // 初始默认赠送 10,000 点开箱体验积分
      const initial = { available: 10000, reserved: 0, totalUsed: 0 };
      this.userBalances.set(key, initial);
      return { ...initial };
    }
    return { ...current };
  }

  public rechargeCredits(userId: string, shopId: string, amount: number): { available: number } {
    const key = this.getAccountKey(userId, shopId);
    const current = this.getBalance(userId, shopId);
    current.available += amount;
    this.userBalances.set(key, current);
    return { available: current.available };
  }

  // =========================================================================
  // 预扣退费路由核心逻辑
  // =========================================================================
  /**
   * 第一步：调用前预扣 (Pre-deduct / Hold)
   * 防止并发调用超支或扣成负数
   */
  public reserveCredits(
    userId: string,
    shopId: string,
    model: string,
    estimatedCredits: number,
  ): { success: boolean; reservationId?: string; error?: string } {
    if (typeof estimatedCredits !== 'number' || Number.isNaN(estimatedCredits) || estimatedCredits <= 0) {
      return {
        success: false,
        error: `预扣积分必须为大于 0 的有效数值，当前传入: ${estimatedCredits}`,
      };
    }

    const key = this.getAccountKey(userId, shopId);
    const balance = this.getBalance(userId, shopId);

    if (balance.available < estimatedCredits) {
      return {
        success: false,
        error: `积分不足：当前可用积分 ${balance.available}，本次预计消耗 ${estimatedCredits}。`,
      };
    }

    // 预扣积分：可用减少，预扣增加
    balance.available -= estimatedCredits;
    balance.reserved += estimatedCredits;
    this.userBalances.set(key, balance);

    const reservationId = `res_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const reservation: PrepayReservation = {
      reservationId,
      userId,
      shopId,
      model,
      estimatedCredits,
      createdAt: Date.now(),
      status: 'reserved',
    };

    this.reservations.set(reservationId, reservation);
    return { success: true, reservationId };
  }

  /**
   * 第二步：调用完成结算与退费 (Settle & Refund Difference)
   * 按实际上游返回的 usage 多退少补
   */
  public settleReservation(
    reservationId: string,
    options: {
      success: boolean;
      providerId: string;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      error?: string;
    },
  ): {
    actualCredits: number;
    refundCredits: number;
    actualCost: number;
    remainingBalance: number;
  } {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    if (reservation.status !== 'reserved') {
      throw new Error(
        `Reservation ${reservationId} 已经结算或失效（当前状态为: ${reservation.status}），严禁重复结算。`,
      );
    }

    const key = this.getAccountKey(reservation.userId, reservation.shopId);
    const balance = this.getBalance(reservation.userId, reservation.shopId);
    const provider = this.providers.get(options.providerId) || this.listProviders()[0];

    // 释放原预扣挂账
    balance.reserved = Math.max(0, balance.reserved - reservation.estimatedCredits);

    if (!options.success) {
      // 调用失败：全额退还预扣积分
      const refundCredits = reservation.estimatedCredits;
      balance.available += refundCredits;
      this.userBalances.set(key, balance);

      reservation.status = 'failed';
      reservation.actualCredits = 0;
      reservation.refundCredits = refundCredits;
      reservation.settledAt = Date.now();

      return {
        actualCredits: 0,
        refundCredits,
        actualCost: 0,
        remainingBalance: balance.available,
      };
    }

    // 调用成功：计算实际消耗与实际成本
    const promptTokens = options.promptTokens || 0;
    const completionTokens = options.completionTokens || 0;
    const totalTokens = options.totalTokens || (promptTokens + completionTokens) || 100;

    const multiplier = provider?.rateMultiplier || 1.0;
    const actualCredits = Math.max(1, Math.ceil((totalTokens / 1000) * multiplier * 10)); // 基础扣费公式
    const actualCost = (totalTokens / 1000) * (provider?.costPer1kTokens || 0.01);

    let refundCredits = 0;
    if (actualCredits < reservation.estimatedCredits) {
      // 多退：退还差额到可用余额
      refundCredits = reservation.estimatedCredits - actualCredits;
      balance.available += refundCredits;
    } else if (actualCredits > reservation.estimatedCredits) {
      // 少补：补扣差额
      const extraDebit = actualCredits - reservation.estimatedCredits;
      balance.available = Math.max(0, balance.available - extraDebit);
    }

    balance.totalUsed += actualCredits;
    this.userBalances.set(key, balance);

    reservation.status = 'settled';
    reservation.actualCredits = actualCredits;
    reservation.refundCredits = refundCredits;
    reservation.providerId = options.providerId;
    reservation.actualCost = actualCost;
    reservation.settledAt = Date.now();

    // 记一笔账入台账（用于审计与毛利核算）
    const ledgerRecord: GuanjiaCreditLedgerRecord = {
      id: crypto.randomUUID(),
      reservationId,
      userId: reservation.userId,
      shopId: reservation.shopId,
      providerId: options.providerId,
      model: reservation.model,
      estimatedCredits: reservation.estimatedCredits,
      actualCredits,
      refundCredits,
      actualCost,
      promptTokens,
      completionTokens,
      totalTokens,
      timestamp: Date.now(),
    };
    this.ledger.unshift(ledgerRecord);
    if (this.ledger.length > 2000) {
      this.ledger.pop();
    }

    return {
      actualCredits,
      refundCredits,
      actualCost,
      remainingBalance: balance.available,
    };
  }

  /**
   * 第三步：端到端模型路由与执行
   * 包含：预扣 -> 多来源故障切换执行 -> 结算退费
   */
  public async routeAndInvokeModel(request: InvokeModelRequest): Promise<InvokeModelResponse> {
    const estimatedCredits = request.customEstimatedCredits || 50; // 默认预扣 50 积分

    // 1. 预扣
    const preDeduct = this.reserveCredits(request.userId, request.shopId, request.model, estimatedCredits);
    if (!preDeduct.success || !preDeduct.reservationId) {
      return {
        success: false,
        reservationId: '',
        estimatedCredits,
        actualCredits: 0,
        refundCredits: 0,
        actualCost: 0,
        error: preDeduct.error || '预扣积分失败',
      };
    }

    const reservationId = preDeduct.reservationId;

    // 2. 故障自动降级路由查找可用 Provider
    const candidateProviders = this.listProviders().filter(
      (p) => p.enabled && (p.models.includes(request.model) || p.models.includes('*')),
    );

    if (candidateProviders.length === 0) {
      // 无可用上游，退还预扣
      const settlement = this.settleReservation(reservationId, {
        success: false,
        providerId: 'none',
        error: '未找到支持该模型的上游来源',
      });
      return {
        success: false,
        reservationId,
        estimatedCredits,
        actualCredits: settlement.actualCredits,
        refundCredits: settlement.refundCredits,
        actualCost: 0,
        error: '无可用模型来源',
      };
    }

    // 依次尝试调用（Failover 自动故障转移）
    let lastError = '';
    for (const provider of candidateProviders) {
      try {
        // 模拟/实际请求处理（若上游网络异常抛出错误，则自动 fallback 到下一个 provider）
        const mockTokens = Math.max(40, Math.ceil(request.prompt.length * 1.5));
        const promptTokens = Math.floor(mockTokens * 0.4);
        const completionTokens = Math.floor(mockTokens * 0.6);
        const totalTokens = promptTokens + completionTokens;

        // 结算并退费
        const settlement = this.settleReservation(reservationId, {
          success: true,
          providerId: provider.id,
          promptTokens,
          completionTokens,
          totalTokens,
        });

        return {
          success: true,
          content: `[由 ${provider.name} 响应]: 已成功处理请求`,
          providerId: provider.id,
          model: request.model,
          reservationId,
          estimatedCredits,
          actualCredits: settlement.actualCredits,
          refundCredits: settlement.refundCredits,
          actualCost: settlement.actualCost,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[GuanjiaModelRouter] Provider ${provider.name} failed, trying next fallback:`, lastError);
      }
    }

    // 所有来源尝试均失败：全额退还预扣
    const settlement = this.settleReservation(reservationId, {
      success: false,
      providerId: candidateProviders[0].id,
      error: lastError,
    });

    return {
      success: false,
      reservationId,
      estimatedCredits,
      actualCredits: 0,
      refundCredits: settlement.refundCredits,
      actualCost: 0,
      error: `所有模型来源均不可用: ${lastError}`,
    };
  }

  public getLedgerRecords(): GuanjiaCreditLedgerRecord[] {
    return [...this.ledger];
  }
}
