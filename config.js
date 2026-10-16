(() => {
  'use strict';
  function normalizeOrigins(input) {
    const entries = Array.isArray(input) ? input : String(input || '').split(/[\s,，;；]+/);
    const origins = [];
    for (let entry of entries) {
      entry = String(entry).trim();
      if (!entry) continue;
      if (!entry.includes('://')) entry = `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(entry) ? 'http' : 'https'}://${entry}`;
      let url;
      try { url = new URL(entry); } catch { throw new Error(`地址格式不正确：${entry}`); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) {
        throw new Error('请填写明确的 HTTP(S) 地址，不支持账号密码或通配符。');
      }
      if (!origins.includes(url.origin)) origins.push(url.origin);
    }
    if (origins.length > 10) throw new Error('最多配置 10 个监听地址。');
    return origins;
  }
  function permissionPattern(origin) {
    const url = new URL(origin);
    // Chrome site permissions are host-based. Exact ports remain enforced by the bridge.
    return `${url.protocol}//${url.hostname}/*`;
  }
  function selectors(value) {
    const result = String(value || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (result.join('\n').length > 2000 || result.length > 20) throw new Error('额外过滤规则最多 20 行、2000 个字符。');
    return result;
  }
  function normalizeSettings(value = {}) {
    return { origins: normalizeOrigins(value.origins || []),
      filterFrontend: value.filterFrontend !== false,
      extraSelectors: selectors(value.extraSelectors).join('\n') };
  }
  const defaults = normalizeSettings();
  globalThis.TavernConfig = Object.freeze({ defaults, normalizeOrigins, permissionPattern,
    patterns: origins => [...new Set(origins.map(permissionPattern))], selectors, normalizeSettings });
})();
