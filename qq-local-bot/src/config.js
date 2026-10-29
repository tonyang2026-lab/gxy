function configuration(env = process.env) {
  const port = Number(env.PORT || 3939);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT须为1～65535');
  const base = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1','localhost','[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Ollama地址须为本机HTTP服务根地址');
  const live = env.QQ_LIVE === 'true';
  if (live && (!env.QQ_APP_ID || !env.QQ_APP_SECRET)) throw new Error('正式模式需要在本机.env设置QQ_APP_ID和QQ_APP_SECRET，不要在聊天中发送密钥');
  return { port, live, appId: env.QQ_APP_ID || '', secret: env.QQ_APP_SECRET || '', webhookSecret: env.QQ_WEBHOOK_SECRET || env.QQ_APP_SECRET || '', sandbox: env.QQ_SANDBOX !== 'false', groups: (env.QQ_ALLOWED_GROUPS || '').split(',').map(s=>s.trim()).filter(Boolean), topics: (env.BOT_TOPICS || '').split(/[,，]/).map(s=>s.trim()).filter(Boolean), model: env.OLLAMA_MODEL || 'qwen2.5:3b', ollamaBase: base.origin };
}
module.exports = { configuration };
