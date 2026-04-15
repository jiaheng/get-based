// test-custom-api.js — Verify Custom API as 6th AI provider
// Run: fetch('tests/test-custom-api.js').then(r=>r.text()).then(s=>Function(s)())
return (async function() {
  const results = [];
  let passed = 0, failed = 0;
  function assert(name, condition, detail) {
    if (condition) { passed++; results.push(`  PASS: ${name}`); }
    else { failed++; results.push(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
  }

  console.log('=== Custom API Provider Tests ===\n');

  // ─── 1. api.js source inspection ───
  console.log('1. api.js source inspection');
  const apiSrc = await fetch('js/api.js').then(r => r.text());
  assert('getCustomApiUrl exists', apiSrc.includes('function getCustomApiUrl()'));
  assert('setCustomApiUrl exists', apiSrc.includes('function setCustomApiUrl('));
  assert('getCustomApiKey exists', apiSrc.includes('function getCustomApiKey()'));
  assert('saveCustomApiKey exists', apiSrc.includes('function saveCustomApiKey('));
  assert('hasCustomApiKey exists', apiSrc.includes('function hasCustomApiKey()'));
  assert('getCustomApiModel exists', apiSrc.includes('function getCustomApiModel()'));
  assert('setCustomApiModel exists', apiSrc.includes('function setCustomApiModel('));
  assert('getCustomApiModelDisplay exists', apiSrc.includes('function getCustomApiModelDisplay()'));
  assert('fetchCustomApiModels exists', apiSrc.includes('function fetchCustomApiModels('));
  assert('validateCustomApiKey exists', apiSrc.includes('function validateCustomApiKey('));
  assert('callCustomAPI exists', apiSrc.includes('function callCustomAPI('));
  // Dispatcher integration
  assert('hasAIProvider handles custom', apiSrc.includes("provider === 'custom') return hasCustomApiKey()"));
  assert('hasAIProvider custom requires URL', apiSrc.includes("hasCustomApiKey() && !!getCustomApiUrl()"));
  assert('getActiveModelId handles custom', apiSrc.includes("provider === 'custom') return getCustomApiModel()"));
  assert('getActiveModelDisplay handles custom', apiSrc.includes("provider === 'custom') return getCustomApiModelDisplay()"));
  assert('callClaudeAPI handles custom', apiSrc.includes("provider === 'custom') return callCustomAPI("));
  assert('supportsWebSearch false for custom', apiSrc.includes("provider === 'custom') return false"));
  assert('supportsVision true for custom', apiSrc.includes("provider === 'custom') return true"));
  // callCustomAPI uses proxy (CORS bypass for hosted version)
  assert('callCustomAPI routes through proxy', apiSrc.includes("'Custom', opts,\n    {}"));
  // Encrypted key storage
  assert('saveCustomApiKey uses encryptedSetItem', apiSrc.includes("encryptedSetItem('labcharts-custom-key'"));
  assert('getCustomApiKey uses getCachedKey', apiSrc.includes("getCachedKey('labcharts-custom-key')"));

  // ─── 2. Window function exports ───
  console.log('\n2. Window function exports');
  assert('window.getCustomApiUrl is function', typeof window.getCustomApiUrl === 'function');
  assert('window.setCustomApiUrl is function', typeof window.setCustomApiUrl === 'function');
  assert('window.getCustomApiKey is function', typeof window.getCustomApiKey === 'function');
  assert('window.saveCustomApiKey is function', typeof window.saveCustomApiKey === 'function');
  assert('window.hasCustomApiKey is function', typeof window.hasCustomApiKey === 'function');
  assert('window.getCustomApiModel is function', typeof window.getCustomApiModel === 'function');
  assert('window.setCustomApiModel is function', typeof window.setCustomApiModel === 'function');
  assert('window.getCustomApiModelDisplay is function', typeof window.getCustomApiModelDisplay === 'function');
  assert('window.fetchCustomApiModels is function', typeof window.fetchCustomApiModels === 'function');
  assert('window.validateCustomApiKey is function', typeof window.validateCustomApiKey === 'function');
  assert('window.callCustomAPI is function', typeof window.callCustomAPI === 'function');
  assert('window.handleSaveCustomApi is function', typeof window.handleSaveCustomApi === 'function');
  assert('window.handleRemoveCustomApi is function', typeof window.handleRemoveCustomApi === 'function');
  assert('window.renderCustomApiModelDropdown is function', typeof window.renderCustomApiModelDropdown === 'function');
  assert('window.applyCustomApiManualModel is function', typeof window.applyCustomApiManualModel === 'function');

  // ─── 3. URL management ───
  console.log('\n3. URL management');
  const oldUrl = localStorage.getItem('labcharts-custom-url');
  localStorage.removeItem('labcharts-custom-url');
  assert('getCustomApiUrl returns empty by default', window.getCustomApiUrl() === '');
  window.setCustomApiUrl('https://api.example.com/v1');
  assert('setCustomApiUrl persists', window.getCustomApiUrl() === 'https://api.example.com/v1');
  assert('localStorage has labcharts-custom-url', localStorage.getItem('labcharts-custom-url') === 'https://api.example.com/v1');
  // Restore
  if (oldUrl) localStorage.setItem('labcharts-custom-url', oldUrl);
  else localStorage.removeItem('labcharts-custom-url');

  // ─── 4. Key management ───
  console.log('\n4. Key management');
  const oldKey = localStorage.getItem('labcharts-custom-key');
  localStorage.removeItem('labcharts-custom-key');
  // Force clear the cache too
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');
  assert('getCustomApiKey returns empty by default', window.getCustomApiKey() === '');
  assert('hasCustomApiKey returns false without key', window.hasCustomApiKey() === false);
  // Restore
  if (oldKey) localStorage.setItem('labcharts-custom-key', oldKey);

  // ─── 5. Model management ───
  console.log('\n5. Model management');
  const oldModel = localStorage.getItem('labcharts-custom-model');
  const oldModels = localStorage.getItem('labcharts-custom-models');
  localStorage.removeItem('labcharts-custom-model');
  assert('getCustomApiModel returns empty by default', window.getCustomApiModel() === '');
  assert('getCustomApiModelDisplay with no model', window.getCustomApiModelDisplay() === '(no model selected)');
  window.setCustomApiModel('gpt-4o');
  assert('setCustomApiModel persists', window.getCustomApiModel() === 'gpt-4o');
  // Model display with cached models
  localStorage.setItem('labcharts-custom-models', JSON.stringify([
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }
  ]));
  assert('getCustomApiModelDisplay resolves name from cache', window.getCustomApiModelDisplay() === 'GPT-4o');
  window.setCustomApiModel('claude-sonnet-4-6');
  assert('getCustomApiModelDisplay resolves second model', window.getCustomApiModelDisplay() === 'Claude Sonnet 4.6');
  // Unknown model falls back to ID
  window.setCustomApiModel('unknown-model-xyz');
  assert('getCustomApiModelDisplay falls back to model ID', window.getCustomApiModelDisplay() === 'unknown-model-xyz');
  // Restore
  if (oldModel) localStorage.setItem('labcharts-custom-model', oldModel);
  else localStorage.removeItem('labcharts-custom-model');
  if (oldModels) localStorage.setItem('labcharts-custom-models', oldModels);
  else localStorage.removeItem('labcharts-custom-models');

  // ─── 6. hasAIProvider integration ───
  console.log('\n6. hasAIProvider integration');
  const oldProvider = localStorage.getItem('labcharts-ai-provider');
  const savedUrl = localStorage.getItem('labcharts-custom-url');
  const savedKey = localStorage.getItem('labcharts-custom-key');
  window.setAIProvider('custom');
  // No URL, no key
  localStorage.removeItem('labcharts-custom-url');
  localStorage.removeItem('labcharts-custom-key');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');
  assert('hasAIProvider false without URL or key', window.hasAIProvider() === false);
  // Key only, no URL
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', 'test-key');
  assert('hasAIProvider false with key but no URL', window.hasAIProvider() === false);
  // URL only, no key
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');
  window.setCustomApiUrl('https://api.example.com/v1');
  assert('hasAIProvider false with URL but no key', window.hasAIProvider() === false);
  // Both URL and key
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', 'test-key');
  assert('hasAIProvider true with both URL and key', window.hasAIProvider() === true);
  // Restore
  if (oldProvider) localStorage.setItem('labcharts-ai-provider', oldProvider);
  else localStorage.removeItem('labcharts-ai-provider');
  if (savedUrl) localStorage.setItem('labcharts-custom-url', savedUrl);
  else localStorage.removeItem('labcharts-custom-url');
  if (savedKey) localStorage.setItem('labcharts-custom-key', savedKey);
  else localStorage.removeItem('labcharts-custom-key');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');

  // ─── 7. getActiveModelId / getActiveModelDisplay ───
  console.log('\n7. getActiveModelId / getActiveModelDisplay');
  const savedProvider2 = localStorage.getItem('labcharts-ai-provider');
  const savedModel2 = localStorage.getItem('labcharts-custom-model');
  const savedModels2 = localStorage.getItem('labcharts-custom-models');
  window.setAIProvider('custom');
  window.setCustomApiModel('my-custom-model');
  assert('getActiveModelId returns custom model', window.getActiveModelId() === 'my-custom-model');
  localStorage.setItem('labcharts-custom-models', JSON.stringify([{ id: 'my-custom-model', name: 'My Custom Model' }]));
  assert('getActiveModelDisplay returns display name', window.getActiveModelDisplay() === 'My Custom Model');
  // Restore
  if (savedProvider2) localStorage.setItem('labcharts-ai-provider', savedProvider2);
  else localStorage.removeItem('labcharts-ai-provider');
  if (savedModel2) localStorage.setItem('labcharts-custom-model', savedModel2);
  else localStorage.removeItem('labcharts-custom-model');
  if (savedModels2) localStorage.setItem('labcharts-custom-models', savedModels2);
  else localStorage.removeItem('labcharts-custom-models');

  // ─── 8. supportsWebSearch / supportsVision ───
  console.log('\n8. supportsWebSearch / supportsVision');
  const savedProvider3 = localStorage.getItem('labcharts-ai-provider');
  window.setAIProvider('custom');
  assert('supportsWebSearch returns false for custom', window.supportsWebSearch() === false);
  assert('supportsVision returns true for custom', window.supportsVision() === true);
  // Restore
  if (savedProvider3) localStorage.setItem('labcharts-ai-provider', savedProvider3);
  else localStorage.removeItem('labcharts-ai-provider');

  // ─── 9. callCustomAPI error handling ───
  console.log('\n9. callCustomAPI error handling');
  const savedUrlErr = localStorage.getItem('labcharts-custom-url');
  const savedKeyErr = localStorage.getItem('labcharts-custom-key');
  localStorage.removeItem('labcharts-custom-url');
  localStorage.removeItem('labcharts-custom-key');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');
  try {
    await window.callCustomAPI({ system: '', messages: [{ role: 'user', content: 'test' }] });
    assert('callCustomAPI throws without URL', false, 'did not throw');
  } catch (e) {
    assert('callCustomAPI throws without URL', e.message.includes('No Custom API URL'));
  }
  window.setCustomApiUrl('https://api.example.com/v1');
  try {
    await window.callCustomAPI({ system: '', messages: [{ role: 'user', content: 'test' }] });
    assert('callCustomAPI throws without key', false, 'did not throw');
  } catch (e) {
    assert('callCustomAPI throws without key', e.message.includes('No Custom API key'));
  }
  // Restore
  if (savedUrlErr) localStorage.setItem('labcharts-custom-url', savedUrlErr);
  else localStorage.removeItem('labcharts-custom-url');
  if (savedKeyErr) localStorage.setItem('labcharts-custom-key', savedKeyErr);
  else localStorage.removeItem('labcharts-custom-key');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');

  // ─── 10. fetchCustomApiModels returns empty without config ───
  console.log('\n10. fetchCustomApiModels edge cases');
  const emptyResult = await window.fetchCustomApiModels('', '');
  assert('fetchCustomApiModels returns [] with empty args', Array.isArray(emptyResult) && emptyResult.length === 0);
  const noKeyResult = await window.fetchCustomApiModels('https://api.example.com/v1', '');
  assert('fetchCustomApiModels returns [] without key', Array.isArray(noKeyResult) && noKeyResult.length === 0);

  // ─── 11. Model pricing ───
  console.log('\n11. Model pricing');
  const pricing = window.renderModelPricingHint('custom', 'any-model');
  assert('custom pricing returns empty (unknown endpoint)', pricing === '');

  // ─── 12. settings.js source inspection ───
  console.log('\n12. settings.js source inspection');
  const settingsSrc = await fetch('js/settings.js').then(r => r.text());
  assert('imports getCustomApiUrl', settingsSrc.includes('getCustomApiUrl'));
  assert('imports setCustomApiUrl', settingsSrc.includes('setCustomApiUrl'));
  assert('imports getCustomApiKey', settingsSrc.includes('getCustomApiKey'));
  assert('imports saveCustomApiKey', settingsSrc.includes('saveCustomApiKey'));
  assert('imports hasCustomApiKey', settingsSrc.includes('hasCustomApiKey'));
  assert('imports getCustomApiModel', settingsSrc.includes('getCustomApiModel'));
  assert('imports setCustomApiModel', settingsSrc.includes('setCustomApiModel'));
  assert('imports getCustomApiModelDisplay', settingsSrc.includes('getCustomApiModelDisplay'));
  assert('imports fetchCustomApiModels', settingsSrc.includes('fetchCustomApiModels'));
  assert('imports validateCustomApiKey', settingsSrc.includes('validateCustomApiKey'));
  assert('6th provider button with data-provider="custom"', settingsSrc.includes('data-provider="custom"'));
  assert('switchAIProvider(\'custom\') in onclick', settingsSrc.includes("switchAIProvider('custom')"));
  assert('renderAIProviderPanel handles custom', settingsSrc.includes("provider === 'custom'"));
  assert('handleSaveCustomApi exists', settingsSrc.includes('function handleSaveCustomApi()'));
  assert('handleRemoveCustomApi exists', settingsSrc.includes('function handleRemoveCustomApi()'));
  assert('renderCustomApiModelDropdown exists', settingsSrc.includes('function renderCustomApiModelDropdown('));
  assert('applyCustomApiManualModel exists', settingsSrc.includes('function applyCustomApiManualModel()'));
  assert('custom-url-input element', settingsSrc.includes('custom-url-input'));
  assert('custom-key-input element', settingsSrc.includes('custom-key-input'));
  assert('custom-model-area element', settingsSrc.includes('custom-model-area'));
  assert('custom-model-select element', settingsSrc.includes('custom-model-select'));
  assert('custom-manual-model element', settingsSrc.includes('custom-manual-model'));
  assert('initSettingsModelFetch handles custom', settingsSrc.includes('fetchCustomApiModels(customUrl, customKey)'));
  // Window exports
  assert('window exports handleSaveCustomApi', settingsSrc.includes('handleSaveCustomApi,'));
  assert('window exports handleRemoveCustomApi', settingsSrc.includes('handleRemoveCustomApi,'));
  assert('window exports renderCustomApiModelDropdown', settingsSrc.includes('renderCustomApiModelDropdown,'));
  assert('window exports applyCustomApiManualModel', settingsSrc.includes('applyCustomApiManualModel,'));
  // Custom panel before Local AI
  const customPanelIdx = settingsSrc.indexOf("// Custom API panel");
  const localPanelIdx = settingsSrc.indexOf("// Local AI panel");
  assert('Custom API panel before Local AI panel', customPanelIdx < localPanelIdx, `custom@${customPanelIdx}, local@${localPanelIdx}`);

  // ─── 13. Settings modal DOM ───
  console.log('\n13. Settings modal DOM');
  window.openSettingsModal('ai');
  await new Promise(r => setTimeout(r, 100));
  const providerBtns = document.querySelectorAll('.ai-provider-btn');
  assert('6 provider buttons in settings', providerBtns.length === 6, `found ${providerBtns.length}`);
  const providerValues = Array.from(providerBtns).map(b => b.dataset.provider);
  assert('provider buttons include custom', providerValues.includes('custom'));
  assert('custom button before local', providerValues.indexOf('custom') < providerValues.indexOf('ollama'));
  // Switch to Custom panel
  window.switchAIProvider('custom');
  await new Promise(r => setTimeout(r, 100));
  assert('custom-url-input exists in DOM', !!document.getElementById('custom-url-input'));
  assert('custom-key-input exists in DOM', !!document.getElementById('custom-key-input'));
  assert('panel has Save & Validate button', !!document.querySelector('.ai-provider-panel .import-btn-primary'));
  assert('panel has OpenAI-compatible description', document.querySelector('.ai-provider-desc').textContent.includes('OpenAI-compatible'));
  // Close settings
  window.closeSettingsModal();

  // ─── 14. Settings DOM with connected state ───
  console.log('\n14. Settings DOM with connected state');
  const sv_url = localStorage.getItem('labcharts-custom-url');
  const sv_key = localStorage.getItem('labcharts-custom-key');
  const sv_model = localStorage.getItem('labcharts-custom-model');
  const sv_models = localStorage.getItem('labcharts-custom-models');
  const sv_prov = localStorage.getItem('labcharts-ai-provider');
  // Set up connected state
  window.setCustomApiUrl('https://api.test.com/v1');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', 'sk-test');
  window.setCustomApiModel('test-model');
  localStorage.setItem('labcharts-custom-models', JSON.stringify([
    { id: 'test-model', name: 'Test Model' },
    { id: 'other-model', name: 'Other Model' }
  ]));
  window.setAIProvider('custom');
  window.openSettingsModal('ai');
  await new Promise(r => setTimeout(r, 100));
  window.switchAIProvider('custom');
  await new Promise(r => setTimeout(r, 100));
  assert('connected status shown', document.getElementById('custom-key-status')?.textContent?.includes('Connected'));
  assert('model dropdown exists in connected state', !!document.getElementById('custom-model-select'));
  const select = document.getElementById('custom-model-select');
  if (select) {
    assert('model dropdown has 2 options', select.options.length === 2, `found ${select.options.length}`);
    assert('selected model is test-model', select.value === 'test-model');
  }
  assert('manual model input exists in connected state', !!document.getElementById('custom-manual-model'));
  assert('Remove button shown in connected state', document.querySelector('.ai-provider-panel').innerHTML.includes('handleRemoveCustomApi'));
  window.closeSettingsModal();
  // Restore
  if (sv_url) localStorage.setItem('labcharts-custom-url', sv_url); else localStorage.removeItem('labcharts-custom-url');
  if (sv_key) localStorage.setItem('labcharts-custom-key', sv_key); else localStorage.removeItem('labcharts-custom-key');
  if (sv_model) localStorage.setItem('labcharts-custom-model', sv_model); else localStorage.removeItem('labcharts-custom-model');
  if (sv_models) localStorage.setItem('labcharts-custom-models', sv_models); else localStorage.removeItem('labcharts-custom-models');
  if (sv_prov) localStorage.setItem('labcharts-ai-provider', sv_prov); else localStorage.removeItem('labcharts-ai-provider');
  window.updateKeyCache && window.updateKeyCache('labcharts-custom-key', '');

  // ─── 15. pdf-import.js model switch ───
  console.log('\n15. pdf-import.js model switch');
  const pdfSrc = await fetch('js/pdf-import.js').then(r => r.text());
  assert('pdf-import imports setCustomApiModel', pdfSrc.includes('setCustomApiModel'));
  assert('pdf-import handles custom in tryAutoSwitchModel', pdfSrc.includes("provider === 'custom') setCustomApiModel("));

  // ─── 16. Service worker bypass ───
  console.log('\n16. Service worker');
  const swSrc = await fetch('service-worker.js').then(r => r.text());
  assert('SW bypasses cross-origin GETs', swSrc.includes('url.hostname !== self.location.hostname'));

  // ─── 17. Proxy supports GET passthrough ───
  console.log('\n17. Proxy GET support');
  const proxySrc = await fetch('api/proxy.js').then(r => r.text());
  assert('proxy extracts method field', proxySrc.includes('method: upstreamMethod'));
  assert('proxy defaults to POST', proxySrc.includes("upstreamMethod || 'POST'"));
  assert('proxy skips body for GET', proxySrc.includes("fetchMethod !== 'GET'"));
  // api.js uses proxy-aware fetch for models
  assert('_customApiFetchModels uses proxy', apiSrc.includes('function _customApiFetchModels('));
  assert('_customApiFetchModels sends method GET via proxy', apiSrc.includes("method: 'GET'"));

  // ─── 18. needsMaxCompletionTokens — GPT-5 / o-series detection (#114) ───
  console.log('\n18. needsMaxCompletionTokens (#114)');
  assert('needsMaxCompletionTokens exists', typeof window.needsMaxCompletionTokens === 'function');
  // Positive: GPT-5 family
  assert('detects gpt-5', window.needsMaxCompletionTokens('gpt-5') === true);
  assert('detects gpt-5.4', window.needsMaxCompletionTokens('gpt-5.4') === true);
  assert('detects gpt-5-codex', window.needsMaxCompletionTokens('gpt-5-codex') === true);
  assert('detects openai/gpt-5 (prefixed)', window.needsMaxCompletionTokens('openai/gpt-5') === true);
  assert('detects openai/gpt-5.4 (prefixed)', window.needsMaxCompletionTokens('openai/gpt-5.4') === true);
  // Positive: o-series reasoning models
  assert('detects o1', window.needsMaxCompletionTokens('o1') === true);
  assert('detects o1-mini', window.needsMaxCompletionTokens('o1-mini') === true);
  assert('detects o3', window.needsMaxCompletionTokens('o3') === true);
  assert('detects o3-mini', window.needsMaxCompletionTokens('o3-mini') === true);
  assert('detects o4-mini', window.needsMaxCompletionTokens('o4-mini') === true);
  assert('detects openai/o3 (prefixed)', window.needsMaxCompletionTokens('openai/o3') === true);
  // Negative: older models that still use max_tokens
  assert('rejects gpt-4', window.needsMaxCompletionTokens('gpt-4') === false);
  assert('rejects gpt-4o', window.needsMaxCompletionTokens('gpt-4o') === false);
  assert('rejects gpt-4-turbo', window.needsMaxCompletionTokens('gpt-4-turbo') === false);
  assert('rejects gpt-3.5-turbo', window.needsMaxCompletionTokens('gpt-3.5-turbo') === false);
  assert('rejects claude-opus-4-6', window.needsMaxCompletionTokens('claude-opus-4-6') === false);
  assert('rejects llama-3.3-70b', window.needsMaxCompletionTokens('llama-3.3-70b') === false);
  assert('rejects gemini-3-pro', window.needsMaxCompletionTokens('gemini-3-pro') === false);
  assert('rejects deepseek-r1', window.needsMaxCompletionTokens('deepseek-r1') === false);
  // Edge cases
  assert('rejects empty string', window.needsMaxCompletionTokens('') === false);
  assert('rejects null', window.needsMaxCompletionTokens(null) === false);
  assert('rejects undefined', window.needsMaxCompletionTokens(undefined) === false);
  // False-positive guards: must not match "gpt-5x" style malformed substrings or "ox" identifiers
  assert('rejects gpt-50 (not GPT-5)', window.needsMaxCompletionTokens('gpt-50') === false);
  assert('rejects ozone (no o[1-9] at start)', window.needsMaxCompletionTokens('ozone') === false);
  assert('rejects openai/gpt-50', window.needsMaxCompletionTokens('openai/gpt-50') === false);
  // callOpenAICompatibleAPI uses the helper to pick the field
  assert('callOpenAICompatibleAPI uses needsMaxCompletionTokens', apiSrc.includes('needsMaxCompletionTokens(model)'));
  assert('body uses dynamic tokenLimitField', apiSrc.includes('[tokenLimitField]:'));
  assert('tokenLimitField defaults to max_tokens', apiSrc.includes("? 'max_completion_tokens' : 'max_tokens'"));

  // ═══ SUMMARY ═══
  console.log('\n' + results.join('\n'));
  console.log(`\n=== ${passed} passed, ${failed} failed, ${passed + failed} total ===`);
  if (failed === 0) console.log('ALL TESTS PASSED');
  else console.warn(`${failed} test(s) failed`);
})();
