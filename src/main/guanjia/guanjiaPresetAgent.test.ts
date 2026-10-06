import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentId } from '../../shared/agent/constants';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => '/tmp',
  },
}));

import { DB_FILENAME } from '../appConstants';
import { CoworkStore } from '../coworkStore';
import { PRESET_AGENTS } from '../presetAgents';
import { SqliteStore } from '../sqliteStore';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

const createTempUserDataPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanjia-agent-test-'));
  tempDirs.push(dir);
  return dir;
};

describe('Guanjia Assistant Resident Agent & Initialization', () => {
  it('should have guanjia-assistant in PRESET_AGENTS with correct persona rules', () => {
    const guanjiaPreset = PRESET_AGENTS.find((agent) => agent.id === AgentId.GuanjiaAssistant);
    expect(guanjiaPreset).toBeDefined();
    expect(guanjiaPreset?.name).toBe('智慧管家助理');
    expect(guanjiaPreset?.id).toBe('guanjia-assistant');

    // 验证核心规则设定
    expect(guanjiaPreset?.identity).toContain('人类店员（店长、前台）的手脚和帮手');
    expect(guanjiaPreset?.systemPrompt).toContain('可以动手');
    expect(guanjiaPreset?.systemPrompt).toContain('动账落定必须停下确认');
    expect(guanjiaPreset?.systemPrompt).toContain('严禁越权');
    expect(guanjiaPreset?.systemPrompt).toContain('不记当日对话与敏感数据');
    expect(guanjiaPreset?.systemPrompt).toContain('不自行算钱');
  });

  it('should auto-initialize guanjia-assistant out-of-the-box in sqliteStore', () => {
    const userDataPath = createTempUserDataPath();
    const sqliteStore = new SqliteStore(userDataPath);
    sqliteStore.init();

    const coworkStore = new CoworkStore(path.join(userDataPath, DB_FILENAME));
    const agents = coworkStore.listAgents();

    const guanjiaAgent = agents.find((a) => a.id === AgentId.GuanjiaAssistant);
    expect(guanjiaAgent).toBeDefined();
    expect(guanjiaAgent?.name).toBe('智慧管家助理');
    expect(guanjiaAgent?.presetId).toBe('guanjia-assistant');
    expect(guanjiaAgent?.source).toBe('preset');
    expect(guanjiaAgent?.enabled).toBe(true);

    sqliteStore.close();
  });

  it('should prevent deletion of guanjia-assistant resident agent', () => {
    const userDataPath = createTempUserDataPath();
    const sqliteStore = new SqliteStore(userDataPath);
    sqliteStore.init();

    const coworkStore = new CoworkStore(path.join(userDataPath, DB_FILENAME));

    // 不能删除 main 和 guanjia-assistant
    const deleteResult = coworkStore.deleteAgent(AgentId.GuanjiaAssistant);
    expect(deleteResult).toBe(false);

    const agents = coworkStore.listAgents();
    expect(agents.some((a) => a.id === AgentId.GuanjiaAssistant)).toBe(true);

    sqliteStore.close();
  });

  it('should support silent clearing of assistant sessions on shift handover', () => {
    const userDataPath = createTempUserDataPath();
    const sqliteStore = new SqliteStore(userDataPath);
    sqliteStore.init();

    const coworkStore = new CoworkStore(path.join(userDataPath, DB_FILENAME));

    // 创建一条属于 guanjia-assistant 的会话
    const session = coworkStore.createSession({
      agentId: AgentId.GuanjiaAssistant,
      title: '交班前的对话',
    });
    coworkStore.addMessage(session.id, {
      role: 'user',
      content: '帮我查一下今天营业额',
    });

    // 交班清场
    const cleared = coworkStore.clearAgentSessions(AgentId.GuanjiaAssistant);
    expect(cleared).toContain(session.id);

    // 确认已删除
    expect(coworkStore.getSession(session.id)).toBeNull();

    sqliteStore.close();
  });
});
