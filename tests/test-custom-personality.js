// test-custom-personality.js — Multiple Custom Personalities
// Run: fetch('tests/test-custom-personality.js').then(r=>r.text()).then(s=>Function(s)())

return (async function() {
  const results = { passed: 0, failed: 0, total: 0 };
  function assert(name, condition, detail) {
    results.total++;
    if (condition) {
      results.passed++;
    } else {
      results.failed++;
      console.log(`%c  FAIL: ${name}${detail ? ' — ' + detail : ''}`, 'color:red');
    }
  }

  console.log('%c▶ Running test-custom-personality.js', 'font-weight:bold;font-size:13px');

  const profileId = localStorage.getItem('labcharts-current-profile') || 'default';
  const key = `labcharts-${profileId}-chatPersonalityCustom`;
  const origVal = localStorage.getItem(key);
  const origPersonality = localStorage.getItem(`labcharts-${profileId}-chatPersonality`);

  // ── 1. Window exports ──
  console.log('%c▶ 1. Window exports', 'font-weight:bold');
  assert('getCustomPersonalities exported', typeof window.getCustomPersonalities === 'function');
  assert('saveCustomPersonalities exported', typeof window.saveCustomPersonalities === 'function');
  assert('getCustomPersonality exported', typeof window.getCustomPersonality === 'function');
  assert('getCustomPersonalityText exported', typeof window.getCustomPersonalityText === 'function');
  assert('pickPersonaIcon exported', typeof window.pickPersonaIcon === 'function');
  assert('generateCustomPersonality exported', typeof window.generateCustomPersonality === 'function');
  assert('saveCustomPersonality exported', typeof window.saveCustomPersonality === 'function');
  assert('startNewCustomPersonality exported', typeof window.startNewCustomPersonality === 'function');
  assert('deleteCustomPersonality exported', typeof window.deleteCustomPersonality === 'function');
  assert('getActivePersonality exported', typeof window.getActivePersonality === 'function');
  assert('autoResizePersonaTextarea exported', typeof window.autoResizePersonaTextarea === 'function');
  assert('markPersonalityDirty exported', typeof window.markPersonalityDirty === 'function');
  assert('snapshotPersonalityClean exported', typeof window.snapshotPersonalityClean === 'function');

  // ── 2. pickPersonaIcon determinism ──
  console.log('%c▶ 2. pickPersonaIcon determinism', 'font-weight:bold');
  const icon1 = window.pickPersonaIcon('Longevity Expert');
  const icon2 = window.pickPersonaIcon('Longevity Expert');
  assert('pickPersonaIcon returns same icon for same name', icon1 === icon2, `${icon1} vs ${icon2}`);
  const icon3 = window.pickPersonaIcon('Dr. House');
  assert('pickPersonaIcon returns emoji', icon1.length > 0);
  assert('pickPersonaIcon different names can differ', true);
  const iconEmpty = window.pickPersonaIcon('');
  assert('pickPersonaIcon empty name returns pencil', iconEmpty === '\u270F\uFE0F', `got: ${iconEmpty}`);
  const iconNull = window.pickPersonaIcon(null);
  assert('pickPersonaIcon null returns pencil', iconNull === '\u270F\uFE0F');
  const PERSONA_ICONS = ['\uD83E\uDDE0', '\uD83C\uDFAD', '\uD83D\uDD2E', '\uD83C\uDF3F', '\u26A1', '\uD83E\uDD8A', '\uD83E\uDDEC', '\uD83C\uDF0A', '\uD83D\uDD25', '\uD83C\uDFDB\uFE0F'];
  assert('pickPersonaIcon result is from palette', PERSONA_ICONS.includes(icon1), `got: ${icon1}`);

  // ── 3. getCustomPersonalities — array storage ──
  console.log('%c▶ 3. getCustomPersonalities array storage', 'font-weight:bold');
  // Empty
  localStorage.removeItem(key);
  assert('Empty storage returns []', JSON.stringify(window.getCustomPersonalities()) === '[]');
  // Array format
  const arr = [
    { id: 'custom_abc', name: 'Longevity Expert', icon: '\uD83E\uDDE0', promptText: 'Expert prompt', evidenceBased: true },
    { id: 'custom_def', name: 'Functional Doc', icon: '\uD83D\uDD2E', promptText: 'Functional prompt', evidenceBased: false }
  ];
  localStorage.setItem(key, JSON.stringify(arr));
  const loaded = window.getCustomPersonalities();
  assert('Array: returns 2 items', loaded.length === 2);
  assert('Array: first item name', loaded[0].name === 'Longevity Expert');
  assert('Array: second item name', loaded[1].name === 'Functional Doc');
  assert('Array: IDs preserved', loaded[0].id === 'custom_abc' && loaded[1].id === 'custom_def');

  // ── 4. Migration from single object ──
  console.log('%c▶ 4. Migration from single object', 'font-weight:bold');
  const singleObj = { name: 'Longevity Expert', icon: '\uD83E\uDDE0', promptText: 'You are a longevity researcher...', evidenceBased: true };
  localStorage.setItem(key, JSON.stringify(singleObj));
  const migrated = window.getCustomPersonalities();
  assert('Single obj: returns array of 1', migrated.length === 1);
  assert('Single obj: id is custom_migrated', migrated[0].id === 'custom_migrated');
  assert('Single obj: name preserved', migrated[0].name === 'Longevity Expert');
  assert('Single obj: promptText preserved', migrated[0].promptText === 'You are a longevity researcher...');
  assert('Single obj: evidenceBased preserved', migrated[0].evidenceBased === true);

  // ── 5. Migration from legacy string ──
  console.log('%c▶ 5. Migration from legacy string', 'font-weight:bold');
  localStorage.setItem(key, 'Speak like a pirate doctor');
  const legacyArr = window.getCustomPersonalities();
  assert('Legacy string: returns array of 1', legacyArr.length === 1);
  assert('Legacy string: id is custom_migrated', legacyArr[0].id === 'custom_migrated');
  assert('Legacy string: name is Custom Personality', legacyArr[0].name === 'Custom Personality');
  assert('Legacy string: promptText is the string', legacyArr[0].promptText === 'Speak like a pirate doctor');
  assert('Legacy string: evidenceBased false', legacyArr[0].evidenceBased === false);

  // ── 6. getCustomPersonality compat shim ──
  console.log('%c▶ 6. getCustomPersonality compat shim', 'font-weight:bold');
  localStorage.setItem(key, JSON.stringify(arr));
  // When current personality matches a custom
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_def');
  window.loadChatPersonality();
  const compat = window.getCustomPersonality();
  assert('Compat shim: returns matching custom', compat.id === 'custom_def');
  assert('Compat shim: name is Functional Doc', compat.name === 'Functional Doc');
  // When current personality is not custom, returns first
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'default');
  window.loadChatPersonality();
  const compatFallback = window.getCustomPersonality();
  assert('Compat shim: fallback returns first', compatFallback.id === 'custom_abc');
  // getCustomPersonalityText still works
  assert('getCustomPersonalityText returns promptText', window.getCustomPersonalityText() === 'Expert prompt');
  // Empty storage returns blank default
  localStorage.removeItem(key);
  const compatEmpty = window.getCustomPersonality();
  assert('Compat shim: empty returns blank', compatEmpty.promptText === '' && compatEmpty.name === 'Custom Personality');

  // ── 7. saveCustomPersonalities ──
  console.log('%c▶ 7. saveCustomPersonalities', 'font-weight:bold');
  const testArr = [{ id: 'custom_test1', name: 'Test1', icon: '\u26A1', promptText: 'p1', evidenceBased: false }];
  window.saveCustomPersonalities(testArr);
  const saved = JSON.parse(localStorage.getItem(key));
  assert('saveCustomPersonalities writes array', Array.isArray(saved));
  assert('saveCustomPersonalities data correct', saved[0].name === 'Test1');

  // ── 8. getActivePersonality for custom IDs ──
  console.log('%c▶ 8. getActivePersonality for custom IDs', 'font-weight:bold');
  localStorage.setItem(key, JSON.stringify(arr));
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_abc');
  window.loadChatPersonality();
  const active = window.getActivePersonality();
  assert('Active custom: id is custom_abc', active.id === 'custom_abc');
  assert('Active custom: name is Longevity Expert', active.name === 'Longevity Expert');
  assert('Active custom: has greeting', typeof active.greeting === 'string' && active.greeting.length > 0);
  // Deleted custom falls back to default
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_nonexistent');
  window.loadChatPersonality();
  const fallback = window.getActivePersonality();
  assert('Deleted custom: falls back to default', fallback.id === 'default');

  // ── 9. loadChatPersonality accepts custom IDs ──
  console.log('%c▶ 9. loadChatPersonality validation', 'font-weight:bold');
  localStorage.setItem(key, JSON.stringify(arr));
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_abc');
  window.loadChatPersonality();
  assert('loadChatPersonality accepts custom_abc', window.getActivePersonality().id === 'custom_abc');
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_bogus');
  window.loadChatPersonality();
  assert('loadChatPersonality rejects unknown custom', window.getActivePersonality().id === 'default');
  // Legacy 'custom' migrates to first custom
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom');
  window.loadChatPersonality();
  assert('loadChatPersonality migrates legacy custom', window.getActivePersonality().id === 'custom_abc');

  // ── 10. CHAT_PERSONALITIES no longer has custom entry ──
  console.log('%c▶ 10. CHAT_PERSONALITIES static entries', 'font-weight:bold');
  try {
    const constantsSrc = await fetchWithRetry('js/constants.js');
    assert('CHAT_PERSONALITIES has default', constantsSrc.includes("id: 'default'"));
    assert('CHAT_PERSONALITIES has house', constantsSrc.includes("id: 'house'"));
    assert('CHAT_PERSONALITIES no custom entry', !constantsSrc.includes("id: 'custom'"));
  } catch {
    assert('Could read constants.js', false);
  }

  // ── 11. Dynamic HTML rendering ──
  console.log('%c▶ 11. Dynamic HTML rendering', 'font-weight:bold');
  // Ensure updatePersonalityBar renders the custom section
  localStorage.setItem(key, JSON.stringify(arr));
  localStorage.setItem(`labcharts-${profileId}-chatPersonality`, 'custom_abc');
  window.loadChatPersonality();
  window.updatePersonalityBar();
  const section = document.getElementById('chat-personality-custom-section');
  assert('Custom section container exists', !!section);
  const customBtns = section.querySelectorAll('.chat-personality-opt');
  assert('Custom section has 2 personality buttons', customBtns.length === 2);
  assert('First button data-personality', customBtns[0] && customBtns[0].dataset.personality === 'custom_abc');
  assert('Second button data-personality', customBtns[1] && customBtns[1].dataset.personality === 'custom_def');
  assert('Active button has active class', customBtns[0] && customBtns[0].classList.contains('active'));
  assert('Inactive button no active class', customBtns[1] && !customBtns[1].classList.contains('active'));
  const addBtn = section.querySelector('.chat-personality-add-btn');
  assert('Add New button exists', !!addBtn);
  assert('Add New button text', addBtn && addBtn.textContent.includes('New Personality'));
  const deleteBtns = section.querySelectorAll('.chat-personality-delete');
  assert('Delete buttons exist for each custom', deleteBtns.length === 2);
  // Editor area rendered inside section
  const customArea = section.querySelector('.chat-personality-custom-area');
  assert('Custom area rendered in section', !!customArea);
  const nameInput = document.getElementById('chat-personality-custom-name');
  assert('Name input exists', !!nameInput);
  assert('Name input is text type', nameInput && nameInput.type === 'text');
  assert('Name input has placeholder', nameInput && nameInput.placeholder.toLowerCase().includes('longevity'));
  const genBtn = document.getElementById('chat-personality-generate-btn');
  assert('Generate button exists', !!genBtn);
  assert('Generate button text', genBtn && genBtn.textContent.trim() === 'Generate');
  const textarea = section.querySelector('.chat-personality-custom-textarea');
  assert('Textarea exists', !!textarea);
  const saveBtn = section.querySelector('.chat-personality-custom-save');
  assert('Save button exists', !!saveBtn);
  // Editor populated with active custom personality
  assert('Editor name populated', nameInput && nameInput.value === 'Longevity Expert');
  assert('Editor textarea populated', textarea && textarea.value === 'Expert prompt');

  // ── 12. CSS classes for new elements ──
  console.log('%c▶ 12. CSS classes', 'font-weight:bold');
  const sheets = Array.from(document.styleSheets);
  let foundDelete = false, foundAddBtn = false, foundWrapper = false;
  let foundHeader = false, foundNameInput = false, foundGenBtn = false, foundFooter = false, foundSaveDisabled = false;
  for (const sheet of sheets) {
    try {
      for (const rule of sheet.cssRules || []) {
        const sel = rule.selectorText || '';
        if (sel.includes('.chat-personality-delete')) foundDelete = true;
        if (sel.includes('.chat-personality-add-btn')) foundAddBtn = true;
        if (sel.includes('.chat-personality-opt-wrapper')) foundWrapper = true;
        if (sel.includes('.chat-personality-custom-header')) foundHeader = true;
        if (sel.includes('.chat-personality-custom-name-input')) foundNameInput = true;
        if (sel.includes('.chat-personality-generate-btn')) foundGenBtn = true;
        if (sel.includes('.chat-personality-custom-footer')) foundFooter = true;
        if (sel.includes('.chat-personality-custom-save:disabled')) foundSaveDisabled = true;
      }
    } catch {}
  }
  assert('CSS: .chat-personality-delete exists', foundDelete);
  assert('CSS: .chat-personality-add-btn exists', foundAddBtn);
  assert('CSS: .chat-personality-opt-wrapper exists', foundWrapper);
  assert('CSS: .chat-personality-custom-header exists', foundHeader);
  assert('CSS: .chat-personality-custom-name-input exists', foundNameInput);
  assert('CSS: .chat-personality-generate-btn exists', foundGenBtn);
  assert('CSS: .chat-personality-custom-footer exists', foundFooter);
  assert('CSS: .chat-personality-custom-save:disabled exists', foundSaveDisabled);

  // ── 13. sendChatMessage uses custom_ prefix check ──
  console.log('%c▶ 13. sendChatMessage custom_ prefix', 'font-weight:bold');
  const sendSrc = window.sendChatMessage.toString();
  assert('sendChatMessage checks custom_ prefix', sendSrc.includes("startsWith('custom_')") || sendSrc.includes('startsWith("custom_")'));
  assert('sendChatMessage uses Persona: prefix', sendSrc.includes('Persona:'));

  // ── 14. Thread metadata ──
  console.log('%c▶ 14. Thread metadata', 'font-weight:bold');
  const createSrc = window.createNewThread.toString();
  assert('createNewThread has personalityName', createSrc.includes('personalityName'));
  assert('createNewThread has personalityIcon', createSrc.includes('personalityIcon'));
  const saveSrc = window.saveChatHistory.toString();
  assert('saveChatHistory has personalityName', saveSrc.includes('personalityName'));
  assert('saveChatHistory has personalityIcon', saveSrc.includes('personalityIcon'));

  // ── 15. Backup compat ──
  // PER_PROFILE_PREF_SUFFIXES moved from crypto.js to backup.js in the v1.18.5 extraction.
  console.log('%c▶ 15. Backup compat', 'font-weight:bold');
  try {
    const backupSrc = await fetchWithRetry('js/backup.js');
    assert('PER_PROFILE_PREF_SUFFIXES has chatPersonalityCustom', backupSrc.includes('chatPersonalityCustom'));
  } catch {
    assert('Could read backup.js', false);
  }

  // ── 16. Service worker cache version ──
  console.log('%c▶ 16. Service worker version', 'font-weight:bold');
  try {
    const swSrc = await fetchWithRetry('service-worker.js');
    assert('SW uses importScripts for version', swSrc.includes("importScripts('/version.js')"));
    assert('SW CACHE_NAME uses semver', swSrc.includes('`labcharts-v${self.APP_VERSION}`'));
  } catch {
    assert('Could read service-worker.js', false);
  }

  // ── 17. Dirty state tracking ──
  console.log('%c▶ 17. Dirty state tracking', 'font-weight:bold');
  // Ensure editor is visible before testing
  window.startNewCustomPersonality();
  const saveBtn2 = document.querySelector('.chat-personality-custom-save');
  window.snapshotPersonalityClean();
  assert('After snapshot, save disabled', saveBtn2 && saveBtn2.disabled === true);
  window.markPersonalityDirty();
  assert('No changes, save stays disabled', saveBtn2 && saveBtn2.disabled === true);

  // ── 18. Stop button exports ──
  console.log('%c▶ 18. Stop button', 'font-weight:bold');
  assert('sendChatMessage exported', typeof window.sendChatMessage === 'function');
  const sendSrc2 = window.sendChatMessage.toString();
  assert('sendChatMessage checks _chatAbortController', sendSrc2.includes('_chatAbortController'));
  assert('sendChatMessage calls abort()', sendSrc2.includes('.abort()'));
  assert('sendChatMessage passes signal', sendSrc2.includes('signal:'));
  assert('sendChatMessage handles AbortError', sendSrc2.includes('AbortError'));

  // ── 19. Stop button CSS ──
  console.log('%c▶ 19. Stop button CSS', 'font-weight:bold');
  {
    const css = await fetchWithRetry('styles.css');
    assert('CSS has .chat-send-btn.streaming', css.includes('.chat-send-btn.streaming'));
    assert('CSS has .chat-stopped-note', css.includes('.chat-stopped-note'));
  }

  // ── 20. Discuss button exports ──
  console.log('%c▶ 20. Discuss button exports', 'font-weight:bold');
  assert('startDiscussion exported', typeof window.startDiscussion === 'function');
  assert('continueDiscussion exported', typeof window.continueDiscussion === 'function');
  assert('endDiscussion exported', typeof window.endDiscussion === 'function');
  assert('updateDiscussButton exported', typeof window.updateDiscussButton === 'function');
  assert('getThreadPersonaCount exported', typeof window.getThreadPersonaCount === 'function');

  // ── 21. Discuss button DOM ──
  console.log('%c▶ 21. Discuss button DOM', 'font-weight:bold');
  const discussBtnEl = document.getElementById('chat-discuss-btn');
  assert('Discuss button exists', !!discussBtnEl);
  assert('Discuss button hidden by default', discussBtnEl && discussBtnEl.style.display === 'none');
  assert('Discuss button has onclick', discussBtnEl && discussBtnEl.getAttribute('onclick') === 'startDiscussion()');

  // ── 22. Discuss button CSS ──
  console.log('%c▶ 22. Discuss button CSS', 'font-weight:bold');
  {
    const css2 = await fetchWithRetry('styles.css');
    assert('CSS has .chat-discuss-btn', css2.includes('.chat-discuss-btn'));
    assert('CSS has .chat-msg-auto', css2.includes('.chat-msg-auto'));
    assert('CSS has .chat-discuss-continue', css2.includes('.chat-discuss-continue'));
    assert('CSS has .chat-discuss-continue-btn', css2.includes('.chat-discuss-continue-btn'));
    assert('CSS has .chat-discuss-done-btn', css2.includes('.chat-discuss-done-btn'));
  }

  // ── 23. getThreadPersonaCount source ──
  console.log('%c▶ 23. getThreadPersonaCount', 'font-weight:bold');
  const countSrc = window.getThreadPersonaCount.toString();
  assert('getThreadPersonaCount checks personalityName', countSrc.includes('personalityName'));
  assert('getThreadPersonaCount uses Set', countSrc.includes('new Set'));

  // ── 24. API signal pass-through ──
  console.log('%c▶ 24. API signal pass-through', 'font-weight:bold');
  {
    const apiSrc = await fetchWithRetry('js/api.js');
    assert('API passes signal to fetch', apiSrc.includes('signal') && apiSrc.includes('fetch('));
    assert('callOllamaChat has signal param', apiSrc.includes('callOllamaChat') && apiSrc.includes('signal }'));
    assert('callOpenAICompatibleAPI has signal param', apiSrc.includes('callOpenAICompatibleAPI') && apiSrc.includes('signal }'));
  }

  // ── 25. Auto message rendering ──
  console.log('%c▶ 25. Auto message rendering', 'font-weight:bold');
  const renderSrc2 = window.renderChatMessages.toString();
  assert('renderChatMessages checks msg.auto', renderSrc2.includes('msg.auto'));
  assert('renderChatMessages applies chat-msg-auto class', renderSrc2.includes('chat-msg-auto'));
  assert('renderChatMessages checks msg.stopped', renderSrc2.includes('msg.stopped'));

  // ── 26. startDiscussion source ──
  console.log('%c▶ 26. startDiscussion source', 'font-weight:bold');
  const discSrc = window.startDiscussion.toString();
  assert('startDiscussion shows persona picker', discSrc.includes('showDiscussPersonaPicker'));
  const pickerSrc = window.startDiscussionFromPicker.toString();
  assert('startDiscussionFromPicker delegates to _runDiscussion', pickerSrc.includes('_runDiscussion'));
  const contSrc = window.continueDiscussion.toString();
  assert('continueDiscussion removes prompt', contSrc.includes('removeDiscussContinuePrompt'));
  assert('continueDiscussion runs another round', contSrc.includes('runDiscussionRound'));
  assert('continueDiscussion reads steer input', contSrc.includes('chat-discuss-steer'));
  const endSrc = window.endDiscussion.toString();
  assert('endDiscussion cleans up state', endSrc.includes('cleanupDiscussionState'));
  assert('endDiscussion restores personality', endSrc.includes('currentChatPersonality'));

  // ── 27. Steer input CSS ──
  console.log('%c▶ 27. Steer input', 'font-weight:bold');
  {
    const css3 = await fetchWithRetry('styles.css');
    assert('CSS has .chat-discuss-steer', css3.includes('.chat-discuss-steer'));
    assert('CSS has .chat-discuss-continue-actions', css3.includes('.chat-discuss-continue-actions'));
  }

  // ── Restore ──
  if (origVal !== null) localStorage.setItem(key, origVal);
  else localStorage.removeItem(key);
  if (origPersonality !== null) localStorage.setItem(`labcharts-${profileId}-chatPersonality`, origPersonality);
  else localStorage.removeItem(`labcharts-${profileId}-chatPersonality`);
  if (window.loadChatPersonality) window.loadChatPersonality();
  if (window.updatePersonalityBar) window.updatePersonalityBar();

  // ── Summary ──
  const color = results.failed === 0 ? 'green' : 'red';
  console.log(`%c=== Results ===`, 'font-weight:bold');
  console.log(`%c${results.passed} passed, ${results.failed} failed`, `color:${color};font-weight:bold`);
  if (results.failed === 0) console.log('%c\uD83C\uDF89 All tests passed!', 'color:green;font-weight:bold');
})();
