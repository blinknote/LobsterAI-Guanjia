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
  error: string;
}

export class GuanjiaModelRouter {
  private static instance: GuanjiaModelRouter | null = null;

  private constructor() {}

  public static getInstance(): GuanjiaModelRouter {
    if (!GuanjiaModelRouter.instance) {
      GuanjiaModelRouter.instance = new GuanjiaModelRouter();
    }
    return GuanjiaModelRouter.instance;
  }

  /**
   * 模拟积分余额已停用，返回明确不可用错误，严禁虚构数值
   */
  public getBalance(_userId?: string, _shopId?: string): { success: false; error: string } {
    return {
      success: false,
      error: '模型路由与模拟积分功能已停用：智慧管家已接入 Cowork 真实模型原生会话',
    };
  }

  /**
   * 模拟预扣退费已停用
   */
  public reserveCredits(): { success: false; error: string } {
    return {
      success: false,
      error: '模拟模型路由积分服务已停用',
    };
  }

  /**
   * 模拟模型调用已停用，返回明确不可用错误，严禁虚构回复或 Token 计数
   */
  public async routeAndInvokeModel(_request?: unknown): Promise<InvokeModelResponse> {
    return {
      success: false,
      error: '模拟模型路由已停用：智慧管家已接入 Cowork 真实模型原生会话',
    };
  }

  public getLedgerRecords(): { success: false; error: string } {
    return {
      success: false,
      error: '模拟积分台账已停用',
    };
  }
}
