import { stdout } from 'node:process';
import type { AgentEvent } from './session/events.js';

export interface EventRendererSink {
  write(value: string): void;
  log(value: string): void;
}

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
  const state = { renderedText: false, lineOpen: false };
  const closeLine = () => {
    if (state.lineOpen) sink.write('\n');
    state.lineOpen = false;
  };
  return {
    get renderedText() { return state.renderedText; },
    onEvent(event) {
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
