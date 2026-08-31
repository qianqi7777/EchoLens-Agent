import { stdout } from 'node:process';
import type { AgentEvent } from './session/events.js';

/**
 * 事件渲染器的输出抽象。
 *
 * `write` 与 `log` 必须分开：模型流式增量不能自带换行，而工具、重试等事件必须独占一行，
 * 两者共用一个入口会让日志插进模型输出中间。分开后测试也能直接注入 sink 断言输出，
 * 不必捕获进程 stdout。
 */
export interface EventRendererSink {
  write(value: string): void;
  log(value: string): void;
}

/**
 * 把 AgentEvent 渲染成终端文本。
 *
 * 返回的 `finish()` 必须被调用：模型流式输出随时可能停在行中间，只有 finish 能补上结尾
 * 换行，否则 shell 提示符会直接接在输出后面。
 * @param sink 默认直连进程 stdout 与 console.log；测试应注入自定义实现。
 */
export function createEventRenderer(
  sink: EventRendererSink = {
    write: (value) => { stdout.write(value); },
    log: (value) => { console.log(value); },
  },
): {
  renderedText: boolean;
  onEvent: (event: AgentEvent) => void;
  finish: () => void;
} {
  // lineOpen 表示上一次写入落在未闭合的行中间；renderedText 供调用方判断本轮是否
  // 真的产生过模型文本，从而决定要不要补分隔线。
  const state = { renderedText: false, lineOpen: false };
  // 只有存在未闭合增量时才补换行，否则连续的整行事件之间会多出空行。
  const closeLine = () => {
    if (state.lineOpen) sink.write('\n');
    state.lineOpen = false;
  };
  return {
    get renderedText() { return state.renderedText; },
    onEvent(event) {
      // 未列出的事件类型一律静默丢弃：它们对终端用户没有信息量，打印反而会打断流式输出。
      if (event.payload.type === 'model.started') {
        closeLine();
        sink.log(`[model] step ${event.payload.step + 1} started`);
      } else if (event.payload.type === 'model.output.delta') {
        sink.write(event.payload.delta);
        state.renderedText = true;
        state.lineOpen = true;
      } else if (event.payload.type === 'tool.started') {
        closeLine();
        sink.log(`[tool] ${event.payload.toolName} started`);
      } else if (event.payload.type === 'tool.progress') {
        closeLine();
        // total 可能缺失（工具无法预估总量），此时只显示已完成计数，不伪造百分比。
        const progress = event.payload.total
          ? `${event.payload.progress}/${event.payload.total}`
          : String(event.payload.progress);
        sink.log(`[tool] ${event.payload.toolName} progress ${progress}`);
      } else if (event.payload.type === 'tool.completed') {
        closeLine();
        sink.log(`[tool] ${event.payload.toolName} ${event.payload.status} ${event.payload.elapsedMs}ms`);
      } else if (event.payload.type === 'model.retry') {
        closeLine();
        sink.log(`[model] retry ${event.payload.attempt} (${event.payload.code})`);
      }
    },
    finish: closeLine,
  };
}
