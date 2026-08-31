// 本模块是 MCP 信任边界：配置解析、外部进程 / HTTP 连接与桥接工具统一在此收口，
// MCP Server 的内容一律按不可信数据处理，不进入 System Policy。
export * from './types.js';
export * from './config.js';
export * from './client-manager.js';
export * from './tool-bridge.js';
