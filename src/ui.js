import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState, markRulesDataDirty, markRulesUiDirty, markPresetsUiDirty } from './state.js';
import { logger } from './log.js';
import { COT_SCOPE_TAG_DISPLAY_TEXT, DEFAULT_SCOPE_TAG_GROUP_ID, DEFAULT_SCOPE_TAG_GROUP_NAME, buildPresetEntry, deepClone, getCurrentCharacterContext, getCurrentChatCompletionPresetName, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetBindingResolution, getPresetBindingUsage, getPresetForCharacter, getPresetRules, isCotScopeTagEntry, isRuleActivationWarningEnabled, mergeScopeTagsWithBuiltins, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

function safeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatReplacementCandidatePreview(value) {
    const normalized = String(value ?? '').replace(/\r/g, '');
    return normalized ? safeHtml(normalized).replace(/\n/g, ' ↵ ') : '【直接删除】';
}

function formatReplacementPreview(replacements, mode = 'text') {
    if (!Array.isArray(replacements) || replacements.length === 0) return '【直接删除】';
    if (mode === 'regex') {
        return replacements.map((value) => `〔${formatReplacementCandidatePreview(value)}〕`).join(' / ');
    }
    return replacements.map(formatReplacementCandidatePreview).join(', ');
}

function getRewriteMode(sub) {
    return sub?.rewriteMode === 'ai' ? 'ai' : 'program';
}

function getRewriteModeBadgeHtml(sub) {
    return getRewriteMode(sub) === 'ai'
        ? '<span class="vrm-tag vrm-ai-rewrite-badge">AI 改写</span>'
        : '';
}

function normalizeReplacementList(replacements) {
    return Array.isArray(replacements) ? replacements.map((value) => String(value ?? '')) : [];
}

function getRulePreviewTagText(mode = 'text') {
    if (mode === 'regex') return '正则';
    if (mode === 'simple') return '简易';
    return '普通';
}

function getRuleSourcePreviewText(sub = {}) {
    const mode = sub.mode || 'text';
    return safeHtml((sub.targets || []).join(mode === 'text' ? ', ' : ' | ')) || '（空）';
}

function getRuleSearchMenuKey(ruleIndex, subRuleIndex) {
    return `${ruleIndex}:${subRuleIndex}`;
}

function applyTauriMobileSurface(selector, surface) {
    $(selector).attr('data-tt-mobile-surface', surface);
}

function annotateTauriMobileSurfaces() {
    applyTauriMobileSurface('#vrm-purifier-popup', 'fullscreen-window');
    applyTauriMobileSurface('.vrm-modal-shell, #vrm-rule-transfer-modal, #vrm-diff-modal, #vrm-loading-overlay', 'backdrop');
    applyTauriMobileSurface('.vrm-modal-card, .vrm-transfer-content, .vrm-diff-modal-card, .vrm-loading-panel, .vrm-scope-tag-editor-card', 'fullscreen-window');
    applyTauriMobileSurface('.vrm-toast', 'free-window');
}

export function isLegacyPurifierDetected() {
    const hasLegacyDom = Boolean(
        document.getElementById('bl-purifier-popup')
        || document.getElementById('bl-wand-btn')
        || document.getElementById('bl-extension-settings-entry')
        || document.getElementById('bl-wand-btn-panel')
    );
    const hasLegacyScript = Array.from(document.scripts || [])
        .some((script) => /\/Veridis-Keyword-filtering-main\//i.test(String(script.src || '')));
    return hasLegacyDom || hasLegacyScript;
}

export function updateLegacyPurifierWarning() {
    const $warning = $('#vrm-legacy-purifier-warning');
    if (!$warning.length) return false;
    const detected = isLegacyPurifierDetected();
    $warning.prop('hidden', !detected);
    return detected;
}

const responsivePageTitles = {
    overview: '首页',
    ai: 'AI',
    clean: '净化',
    bind: '绑定',
    tools: '工具',
};

export function showResponsivePage(pageId = 'overview') {
    const normalizedPage = responsivePageTitles[pageId] ? pageId : 'overview';
    const title = responsivePageTitles[normalizedPage];
    const $popup = $('#vrm-purifier-popup');
    if (!$popup.length) return;

    $popup.find('.page-panel').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page') || '') === normalizedPage);
    });
    $popup.find('.rail-btn, .nav-item').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page-target') || '') === normalizedPage);
    });
    $popup.find('[data-title], #vrm-responsive-title').text(title);
    $popup.find('#vrm-character-bind-toggle').attr('aria-expanded', 'false');
}

function buildRuleSearchHaystack(sub = {}) {
    const mode = sub.mode || 'text';
    const targets = Array.isArray(sub.targets) ? sub.targets.join(mode === 'text' ? ' ' : '\n') : '';
    const replacements = Array.isArray(sub.replacements) ? sub.replacements.join('\n') : '';
    return `${targets}\n${replacements}`.toLowerCase();
}

function buildRuleSearchResults(keyword) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return [];

    const { extension_settings } = getAppContext();
    const rules = extension_settings?.[extensionName]?.rules || [];
    const results = [];

    rules.forEach((rule, ruleIndex) => {
        (rule.subRules || []).forEach((sub, subRuleIndex) => {
            if (!buildRuleSearchHaystack(sub).includes(normalizedKeyword)) return;
            const mode = sub.mode || 'text';
            results.push({
                key: getRuleSearchMenuKey(ruleIndex, subRuleIndex),
                ruleIndex,
                subRuleIndex,
                groupName: safeHtml(rule.name || `合集 ${ruleIndex + 1}`),
                tagText: getRulePreviewTagText(mode),
                sourcePreview: getRuleSourcePreviewText(sub),
                replacementPreview: formatReplacementPreview(sub.replacements || [], mode),
                isEnabled: rule.enabled !== false && sub.enabled !== false,
            });
        });
    });

    return results;
}

function getRegexReplacementEditIndex() {
    const rawIndex = Number($('#vrm-modal-sub-rep').data('regex-edit-index'));
    return Number.isInteger(rawIndex) ? rawIndex : -1;
}

function getRegexReplacementChipValues() {
    return $('#vrm-modal-sub-regex-list').children('.vrm-regex-replacement-chip').map(function() {
        return String($(this).data('value') ?? '');
    }).get();
}

function buildRegexReplacementChip(value = '') {
    const normalizedValue = String(value ?? '');
    const preview = formatReplacementCandidatePreview(normalizedValue);
    const $chip = $(`
        <div class="vrm-regex-replacement-chip" data-index="0">
            <button type="button" class="vrm-regex-replacement-chip-main" data-index="0" title="点击编辑替换项"></button>
            <button type="button" class="vrm-regex-replacement-chip-remove" data-index="0" title="删除替换项">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `);
    $chip.data('value', normalizedValue);
    $chip.find('.vrm-regex-replacement-chip-main').html(preview).attr('title', normalizedValue || '点击编辑替换项');
    return $chip;
}

function appendRegexReplacementInputs(values = [], options = {}) {
    const normalizedValues = normalizeReplacementList(values);
    const { sync = true } = options;
    if (normalizedValues.length === 0) return $();

    const $container = $('#vrm-modal-sub-regex-list');
    const fragment = document.createDocumentFragment();
    const nodes = [];
    normalizedValues.forEach((value) => {
        const node = buildRegexReplacementChip(value)[0];
        nodes.push(node);
        fragment.appendChild(node);
    });
    $container.append(fragment);
    if (sync) syncRegexReplacementInputState();
    return $(nodes);
}

function syncRegexReplacementInputState() {
    const $container = $('#vrm-modal-sub-regex-list');
    const $textarea = $('#vrm-modal-sub-rep');
    $container.children('.vrm-regex-replacement-empty').remove();
    const $items = $container.children('.vrm-regex-replacement-chip');
    let editIndex = getRegexReplacementEditIndex();
    if (editIndex >= $items.length) {
        editIndex = -1;
        $textarea.data('regex-edit-index', -1);
    }
    $items.each((index, element) => {
        const $element = $(element);
        $element.attr('data-index', index);
        $element.toggleClass('is-active', index === editIndex);
        $element.find('.vrm-regex-replacement-chip-main').attr('data-index', index);
        $element.find('.vrm-regex-replacement-chip-remove').attr('data-index', index);
    });
    const isEditing = editIndex >= 0;
    const defaultPlaceholder = String($textarea.data('regex-default-placeholder') || '');
    const editPlaceholder = String($textarea.data('regex-edit-placeholder') || defaultPlaceholder);
    const isRegexEditorVisible = !$('#vrm-modal-sub-regex-actions').prop('hidden');
    if ($items.length === 0 && isRegexEditorVisible) {
        $container.append(`
            <div class="vrm-regex-replacement-empty" aria-live="polite">
                <i class="fas fa-eraser"></i>
                <span>未添加替换项，命中后将直接删除。</span>
            </div>
        `);
    }
    $container.prop('hidden', $items.length === 0 && !isRegexEditorVisible);
    $('#vrm-modal-sub-regex-recognize').text(isEditing ? '更新替换项' : '按行识别');
    $textarea.attr('placeholder', isEditing ? editPlaceholder : defaultPlaceholder);
}

export function showToast(message) {
    $('.vrm-toast').remove();
    const themeMode = String($('#vrm-purifier-popup').attr('data-vrm-theme') || 'auto');
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $(`<div class="vrm-toast" data-vrm-theme="${themeMode}" data-tt-mobile-surface="free-window" role="status" aria-live="polite"><i class="fas fa-exclamation-circle" style="margin-right: 6px; font-size: 15px;"></i><span class="vrm-toast-text"></span></div>`);
    $toast.find('.vrm-toast-text').text(String(message || ''));
    $('body').append($toast);
    setTimeout(() => $toast.addClass('vrm-show'), 10);
    setTimeout(() => {
        $toast.removeClass('vrm-show');
        setTimeout(() => $toast.remove(), 300);
    }, 2000);
}

export async function setupUI(renderTemplate) {
    if (typeof renderTemplate !== 'function') {
        throw new TypeError('setupUI requires a SillyTavern template renderer');
    }
    logger.debug('[setupUI] 开始初始化 UI');
    $('#vrm-purifier-popup, #vrm-rule-edit-modal, #vrm-risk-confirm-modal, #vrm-risk-info-modal, #vrm-confirm-modal, #vrm-rule-transfer-modal, #vrm-preset-import-choice-modal, #vrm-rule-search-modal, #vrm-scope-tags-modal, #vrm-scope-tag-editor-modal, #vrm-diff-modal, #vrm-subrule-edit-modal, #vrm-ai-prompt-modal, #vrm-loading-overlay, .vrm-toast').remove();

    const ensureExtensionPanelEntry = () => {
        if ($('#vrm-extension-settings-entry').length || !$('#extensions_settings').length) return;
        $('#extensions_settings').append(`
            <div id="vrm-extension-settings-entry" class="inline-drawer vrm-extension-settings-entry">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Veridis Rewrite Modified</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                </div>
                <div class="inline-drawer-content">
                    <button id="vrm-wand-btn-panel" type="button" class="menu_button vrm-extension-open-btn">
                        <i class="fa-solid fa-language fa-fw"></i>
                        <span>打开 AI 词汇映射</span>
                    </button>
                </div>
            </div>
        `);
    };

    if (!$('#vrm-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="vrm-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }
    ensureExtensionPanelEntry();
    window.setTimeout(ensureExtensionPanelEntry, 500);

    const templateHtml = await renderTemplate(
        'third-party/Veridis-Rewrite-Modified/templates',
        'purifier',
        {},
        false,
        false,
    );
    $('body').append(templateHtml);
    updateLegacyPurifierWarning();
    window.setTimeout(updateLegacyPurifierWarning, 800);
    markRulesUiDirty(true);
    markPresetsUiDirty(true);
    annotateTauriMobileSurfaces();
}

export function clearRuleSearchEditFlow() {
    runtimeState.searchEditFlow.active = false;
    runtimeState.searchEditFlow.returnMode = '';
    runtimeState.searchEditFlow.ruleIndex = -1;
    runtimeState.searchEditFlow.subRuleIndex = -1;
}

export function resetRuleSearchState() {
    runtimeState.ruleSearchKeyword = '';
    runtimeState.ruleSearchDraftKeyword = '';
    runtimeState.ruleSearchHasSearched = false;
    runtimeState.ruleSearchExpandedMenuKey = '';
    clearRuleSearchEditFlow();
}

export function syncRuleSearchInputUi(options = {}) {
    const { syncValue = false } = options;
    const draftKeyword = String(runtimeState.ruleSearchDraftKeyword || '');
    const $input = $('#vrm-rule-search-input');
    const $field = $input.closest('.vrm-rule-search-field');
    const $clear = $('#vrm-rule-search-clear');
    if (syncValue && $input.length) $input.val(draftKeyword);
    const hasValue = draftKeyword.length > 0;
    $field.toggleClass('has-value', hasValue);
    $clear.prop('hidden', !hasValue).toggleClass('is-visible', hasValue);
}

export function renderRuleSearchModal() {
    const $body = $('#vrm-rule-search-body');
    if (!$body.length) return;

    const keyword = String(runtimeState.ruleSearchKeyword || '').trim();
    syncRuleSearchInputUi();

    if (!runtimeState.ruleSearchHasSearched || !keyword) {
        $body.html(`
            <div class="vrm-rule-search-empty">
                <div class="vrm-rule-search-empty-icon"><i class="fas fa-magnifying-glass"></i></div>
                <div class="vrm-rule-search-empty-title">请输入关键词</div>
                <div class="vrm-rule-search-empty-text">点击“搜索”查找对应规则</div>
            </div>
        `);
        return;
    }

    const results = buildRuleSearchResults(keyword);
    if (results.length === 0) {
        $body.html(`
            <div class="vrm-rule-search-empty">
                <div class="vrm-rule-search-empty-icon"><i class="fas fa-circle-info"></i></div>
                <div class="vrm-rule-search-empty-title">未找到匹配规则</div>
                <div class="vrm-rule-search-empty-text">当前只搜索每条映射的查找词与替换词</div>
            </div>
        `);
        return;
    }

    const html = results.map((item) => {
        const menuHtml = runtimeState.ruleSearchExpandedMenuKey === item.key
            ? `
                <div class="vrm-rule-search-menu">
                    <button type="button" class="vrm-rule-search-menu-item" data-action="group" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        分组详情
                    </button>
                    <button type="button" class="vrm-rule-search-menu-item" data-action="subrule" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        编辑条目
                    </button>
                </div>
            `
            : '';

        return `
            <div class="vrm-rule-search-result-card ${item.isEnabled ? '' : 'vrm-is-disabled'}" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                <div class="vrm-rule-search-result-head">
                    <div class="vrm-rule-search-result-group">
                        <i class="fas fa-folder-open"></i>
                        所属分组：${item.groupName}
                    </div>
                    <div class="vrm-rule-search-menu-wrap">
                        <button type="button" class="vrm-icon-btn vrm-rule-search-menu-toggle" data-key="${item.key}" title="更多操作">
                            <i class="fas fa-ellipsis"></i>
                        </button>
                        ${menuHtml}
                    </div>
                </div>
                <div class="vrm-rule-search-result-preview">
                    <span class="vrm-tag">${item.tagText}</span>
                    <span class="vrm-source">${item.sourcePreview}</span>
                    <i class="fas fa-arrow-right vrm-arrow"></i>
                    <span class="vrm-target">${item.replacementPreview}</span>
                </div>
            </div>
        `;
    }).join('');

    $body.html(`<div class="vrm-rule-search-results">${html}</div>`);
}

export function openRuleSearchModal() {
    syncRuleSearchInputUi({ syncValue: true });
    renderRuleSearchModal();
    $('#vrm-rule-search-modal').css('display', 'flex').hide().fadeIn(150);
    window.setTimeout(() => {
        $('#vrm-rule-search-input').trigger('focus');
    }, 20);
}

export function closeRuleSearchModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        resetRuleSearchState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
    }
    $('#vrm-rule-search-modal').fadeOut(150);
}

function getScopeTagGroupsForSettings(settings = {}) {
    return normalizeScopeTagGroupList(settings?.scopeTagGroups);
}

function getScopeTagCollapsedGroupSet(settings = {}, groups = []) {
    return new Set(normalizeScopeTagCollapsedGroupList(settings?.scopeTagCollapsedGroups, groups));
}

function getScopeTagDisplayGroupId(scopeTag, groupIds) {
    const groupId = String(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
    return groupIds.has(groupId) ? groupId : DEFAULT_SCOPE_TAG_GROUP_ID;
}

function buildScopeTagChipHtml(scopeTag, editId) {
    const isEnabled = scopeTag.enabled !== false;
    const checkedAttr = isEnabled ? 'checked' : '';
    const activeClass = scopeTag.id === editId ? 'is-active' : '';
    const disabledClass = isEnabled ? '' : 'vrm-is-disabled';
    const labelText = String(scopeTag.label || '').trim();
    const rangeText = isCotScopeTagEntry(scopeTag)
        ? COT_SCOPE_TAG_DISPLAY_TEXT
        : `${scopeTag.startTag} ... ${scopeTag.endTag}`;
    const primaryText = labelText || '标签范围';
    const chipTitle = `${primaryText} · ${rangeText}`;
    return `
        <div class="vrm-scope-tag-chip ${activeClass} ${disabledClass}" data-id="${safeHtml(scopeTag.id)}">
            <label class="vrm-checkbox-label vrm-scope-tag-toggle-wrap" title="启用或停用该标签">
                <input type="checkbox" class="vrm-scope-tag-toggle" data-id="${safeHtml(scopeTag.id)}" ${checkedAttr}>
                <span class="vrm-custom-checkbox vrm-square"></span>
            </label>
            <button type="button" class="vrm-scope-tag-chip-main" data-id="${safeHtml(scopeTag.id)}" title="${safeHtml(chipTitle)}">
                <span class="vrm-scope-tag-chip-title">${safeHtml(primaryText)}</span>
                <span class="vrm-scope-tag-chip-text">${safeHtml(rangeText)}</span>
            </button>
            <span class="vrm-scope-tag-row-divider" aria-hidden="true"></span>
            <div class="vrm-scope-tag-actions">
                <button type="button" class="vrm-icon-btn vrm-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="vrm-icon-btn vrm-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="vrm-icon-btn vrm-scope-tag-edit" data-id="${safeHtml(scopeTag.id)}" title="编辑标签" aria-label="编辑标签"><i class="fas fa-pen"></i></button>
                <button type="button" class="vrm-icon-btn vrm-scope-tag-del vrm-danger-btn" data-id="${safeHtml(scopeTag.id)}" title="删除标签" aria-label="删除标签"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

export function renderScopeTagsModal() {
    const $list = $('#vrm-scope-tags-list');
    if (!$list.length) return;

    const isGroupManageMode = $list.hasClass('vrm-is-group-manage-mode');

    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    const groups = getScopeTagGroupsForSettings(settings);
    const groupIds = new Set(groups.map((group) => group.id));
    const collapsedGroups = getScopeTagCollapsedGroupSet(settings, groups);
    const scopeTags = mergeScopeTagsWithBuiltins(
        settings.scopeTags,
        settings.scopeTagBuiltinDismissed
    );
    const editId = String($('#vrm-scope-tag-input').data('scope-edit-id') || '');
    const isEditing = editId !== '';
    const scopeTagMode = settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const isCleanseInsideMode = scopeTagMode === 'cleanse-inside';
    const displayScopeTags = [];
    let cotDisplayTag = null;

    scopeTags.forEach((scopeTag) => {
        if (!isCotScopeTagEntry(scopeTag)) {
            displayScopeTags.push(scopeTag);
            return;
        }
        if (!cotDisplayTag) {
            cotDisplayTag = {
                ...scopeTag,
                label: scopeTag.label || 'COT思维链',
                enabled: false,
                groupId: getScopeTagDisplayGroupId(scopeTag, groupIds),
            };
            displayScopeTags.push(cotDisplayTag);
        }
        if (scopeTag.enabled !== false) cotDisplayTag.enabled = true;
        if (scopeTag.id === editId) cotDisplayTag.id = scopeTag.id;
    });

    $('#vrm-scope-tag-total-count').text(`共 ${displayScopeTags.length} 个标签`);
    $('#vrm-scope-group-manage-open')
        .toggleClass('is-active', isGroupManageMode)
        .attr('aria-pressed', String(isGroupManageMode))
        .attr('title', isGroupManageMode ? '完成分组管理' : '管理分组')
        .attr('aria-label', isGroupManageMode ? '完成分组管理' : '管理分组')
        .find('i')
        .attr('class', isGroupManageMode ? 'fas fa-check' : 'fas fa-layer-group');

    $('#vrm-scope-tag-editor-title').text(isEditing ? '编辑标签' : '新增标签');
    $('#vrm-scope-tag-save').text('确认');
    $('#vrm-scope-tag-reset').text('取消');
    $('#vrm-scope-mode-protect')
        .toggleClass('is-active', !isCleanseInsideMode)
        .attr('aria-pressed', String(!isCleanseInsideMode));
    $('#vrm-scope-mode-cleanse')
        .toggleClass('is-active', isCleanseInsideMode)
        .attr('aria-pressed', String(isCleanseInsideMode));
    $('#vrm-scope-tags-hint').text(isCleanseInsideMode
        ? '当前模式下，只会删除或替换列表内标签的内容，标签外内容会被保留。'
        : '当前模式下，列表内标签的内容将被跳过，只对标签外的内容进行净化。');

    const grouped = groups.map((group) => ({ ...group, tags: [] }));
    const groupedMap = new Map(grouped.map((group) => [group.id, group]));
    displayScopeTags.forEach((scopeTag) => {
        const groupId = getScopeTagDisplayGroupId(scopeTag, groupIds);
        const targetGroup = groupedMap.get(groupId) || groupedMap.get(DEFAULT_SCOPE_TAG_GROUP_ID) || grouped[0];
        if (targetGroup) targetGroup.tags.push(scopeTag);
    });

    const html = grouped.map((group, groupIndex) => {
        const isCollapsed = collapsedGroups.has(group.id);
        const groupTitle = safeHtml(group.name || DEFAULT_SCOPE_TAG_GROUP_NAME);
        const isDefaultGroup = group.id === DEFAULT_SCOPE_TAG_GROUP_ID;
        const activeCount = group.tags.filter((scopeTag) => scopeTag.enabled !== false).length;
        const hasTags = group.tags.length > 0;
        const isGroupEnabled = activeCount > 0;
        const isGroupPartial = activeCount > 0 && activeCount < group.tags.length;
        const groupToggleClass = [
            'vrm-scope-tag-group-toggle',
            isGroupEnabled ? 'is-on' : '',
            isGroupPartial ? 'is-partial' : '',
        ].filter(Boolean).join(' ');
        const groupToggleTitle = hasTags
            ? (isGroupEnabled ? '关闭该分组内全部标签' : '启用该分组内全部标签')
            : '此分组暂无标签';
        const groupToggleDisabled = hasTags ? '' : 'disabled';
        const tagsHtml = group.tags.length > 0
            ? group.tags.map((scopeTag) => buildScopeTagChipHtml(scopeTag, editId)).join('')
            : `<div class="vrm-scope-tag-group-empty">${isCleanseInsideMode ? '此分组暂无标签。' : '此分组暂无标签。'}</div>`;
        const groupHeadHtml = isGroupManageMode
            ? `
                <input type="text" class="vrm-scope-group-name-input" data-group-id="${safeHtml(group.id)}" value="${groupTitle}" aria-label="分组名称">
                <span class="vrm-scope-tag-group-count">${group.tags.length} 个标签</span>
                <div class="vrm-scope-group-manager-item-actions" aria-label="${groupTitle}分组操作">
                    <button type="button" class="vrm-icon-btn vrm-scope-group-move-up" data-group-id="${safeHtml(group.id)}" title="上移分组" aria-label="上移分组" ${groupIndex === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button type="button" class="vrm-icon-btn vrm-scope-group-move-down" data-group-id="${safeHtml(group.id)}" title="下移分组" aria-label="下移分组" ${groupIndex === grouped.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                    <button type="button" class="vrm-icon-btn vrm-scope-group-delete vrm-danger-btn" data-group-id="${safeHtml(group.id)}" title="${isDefaultGroup ? '默认分组不可删除' : '删除分组'}" aria-label="${isDefaultGroup ? '默认分组不可删除' : '删除分组'}" ${isDefaultGroup ? 'disabled' : ''}><i class="fas fa-trash"></i></button>
                </div>
            `
            : `
                <button type="button" class="vrm-scope-tag-group-collapse" data-group-id="${safeHtml(group.id)}" aria-expanded="${String(!isCollapsed)}">
                    <svg class="vrm-scope-tag-group-caret" viewBox="0 0 24 24" aria-hidden="true">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                    <span class="vrm-scope-tag-group-title">${groupTitle}</span>
                </button>
                <span class="vrm-scope-tag-group-count">${group.tags.length} 个标签</span>
                <button type="button" class="${groupToggleClass}" data-group-id="${safeHtml(group.id)}" aria-pressed="${String(isGroupEnabled)}" title="${safeHtml(groupToggleTitle)}" ${groupToggleDisabled}>
                    <span class="vrm-scope-tag-group-toggle-track" aria-hidden="true">
                        <span class="vrm-scope-tag-group-toggle-knob"></span>
                    </span>
                </button>
            `;
        return `
            <div class="vrm-scope-tag-group ${isCollapsed ? 'is-collapsed' : ''}" data-group-id="${safeHtml(group.id)}">
                <div class="vrm-scope-tag-group-head ${isGroupManageMode ? 'vrm-is-managing' : ''}">
                    ${groupHeadHtml}
                </div>
                <div class="vrm-scope-tag-group-body">
                    <div class="vrm-scope-tag-group-inner">
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(html || `<div class="vrm-empty-state">${isCleanseInsideMode ? '当前没有标签，新增并启用后才会净化标签内内容。' : '当前没有标签，新增后即可保护对应标签内容。'}</div>`);
}

export function openScopeTagsModal() {
    renderScopeTagsModal();
    showResponsivePage('clean');
    const $cleanPage = $('#vrm-purifier-popup .page-panel[data-page="clean"]');
    $cleanPage.find('[data-clean-tab]')
        .removeClass('is-active')
        .attr('aria-selected', 'false');
    $cleanPage.find('[data-clean-tab="tags"]')
        .addClass('is-active')
        .attr('aria-selected', 'true');
    $cleanPage.find('[data-clean-pane]').removeClass('is-active');
    $cleanPage.find('[data-clean-pane="tags"]').addClass('is-active');
}

export function closeScopeTagsModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        $('#vrm-scope-tag-input').val('').data('scope-edit-id', '');
        $('#vrm-scope-tag-label-input').val('');
        $('#vrm-scope-tag-error').removeClass('is-visible').text('');
        $('#vrm-scope-tag-input').removeClass('vrm-invalid').removeAttr('aria-invalid');
        $('#vrm-scope-tag-editor-modal')
            .removeClass('vrm-is-open')
            .attr('aria-hidden', 'true');
        $('#vrm-scope-tags-list').removeClass('vrm-is-group-manage-mode');
        $('#vrm-scope-tag-action-menu').prop('hidden', true);
        $('#vrm-scope-tag-menu-open').attr('aria-expanded', 'false');
        renderScopeTagsModal();
    }
    showResponsivePage('overview');
}

export function focusLatestRuleCard() {
    const container = document.getElementById('vrm-tags-container');
    if (!container) return;

    const cards = container.querySelectorAll('.vrm-card');
    const latestCard = cards[cards.length - 1];
    if (!latestCard) return;

    const containerRect = container.getBoundingClientRect();
    const cardRect = latestCard.getBoundingClientRect();
    const isVisible = cardRect.top >= containerRect.top && cardRect.bottom <= containerRect.bottom;

    if (!isVisible) {
        latestCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    latestCard.classList.remove('vrm-highlight-flash');
    void latestCard.offsetWidth;
    latestCard.classList.add('vrm-highlight-flash');

    window.setTimeout(() => {
        latestCard.classList.remove('vrm-highlight-flash');
    }, 1600);
}

function showProgressOverlay({ title, statusText, cancelText = '停止', onCancel = null }) {
    const themeMode = String($('#vrm-purifier-popup').attr('data-vrm-theme') || 'auto');
    $('#vrm-loading-overlay').remove();
    $('body').append(`
        <div id="vrm-loading-overlay" class="vrm-loading-overlay" data-vrm-theme="${themeMode}" data-tt-mobile-surface="backdrop">
            <div class="vrm-loading-panel" data-tt-mobile-surface="fullscreen-window" role="dialog" aria-modal="true" aria-labelledby="vrm-loading-title">
                <div class="vrm-loading-head">
                    <h2 id="vrm-loading-title" class="vrm-loading-title"><i class="fas fa-spinner fa-spin"></i> ${title}</h2>
                    <button id="vrm-loading-cancel" type="button" class="vrm-loading-cancel" title="${cancelText}">${cancelText}</button>
                </div>
                <p id="vrm-loading-status">${statusText}</p>
                <div class="vrm-progress-track"><div id="vrm-progress-fill" class="vrm-progress-fill"></div></div>
                <p id="vrm-progress-percent" class="vrm-progress-percent">0%</p>
            </div>
        </div>
    `);
    annotateTauriMobileSurfaces();
    if (typeof onCancel === 'function') {
        $('#vrm-loading-cancel').off('click').on('click', onCancel);
    }
}

export function showDeepCleanOverlay() {
    runtimeState.deepCleanCancelRequested = false;
    showProgressOverlay({
        title: '正在执行全方位深度清理',
        statusText: '正在初始化清理任务，请稍候。',
        cancelText: '停止',
        onCancel: () => {
            runtimeState.deepCleanCancelRequested = true;
            $('#vrm-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('停止中');
            $('#vrm-loading-status').text('正在停止深度清理，请等待当前批次收尾。');
        },
    });
}

export function showZhDictionaryInstallOverlay(onCancel) {
    runtimeState.zhDictionaryInstallCancelRequested = false;
    showProgressOverlay({
        title: '正在安装增强简繁词典',
        statusText: '正在初始化下载任务。',
        cancelText: '取消',
        onCancel: () => {
            runtimeState.zhDictionaryInstallCancelRequested = true;
            $('#vrm-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('取消中');
            $('#vrm-loading-status').text('正在取消下载，请等待当前请求结束。');
            if (typeof onCancel === 'function') onCancel();
        },
    });
}

export function closeLoadingOverlay() {
    $('#vrm-loading-overlay').remove();
}

export function updateZhDictionaryInstallOverlay(progressRatio, statusText) {
    updateDeepCleanOverlay(progressRatio, statusText);
}

export function openZhDictionaryModal(stats = {}, options = {}) {
    const themeMode = String($('#vrm-purifier-popup').attr('data-vrm-theme') || 'auto');
    const bytes = Number(stats.bytes) || 0;
    const mb = bytes > 0 ? (bytes / 1024 / 1024).toFixed(2) : '1.20';
    const entries = Number(stats.entries) || 0;
    $('#vrm-zh-dictionary-modal')
        .attr('data-vrm-theme', themeMode)
        .css('display', 'flex');
    $('#vrm-zh-dict-stats').text(`词典包约 ${mb} MB，包含 ${entries.toLocaleString('zh-CN')} 条字词与异体映射。`);
    $('#vrm-zh-dict-tw').prop('checked', options.tw !== false);
    $('#vrm-zh-dict-hk').prop('checked', options.hk !== false);
}

export function closeZhDictionaryModal() {
    $('#vrm-zh-dictionary-modal').fadeOut(120);
}

export function updateDeepCleanOverlay(progressRatio, statusText) {
    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    $('#vrm-progress-fill').css('width', `${Math.round(ratio * 100)}%`);
    $('#vrm-progress-percent').text(`${Math.round(ratio * 100)}%`);
    if (statusText) $('#vrm-loading-status').text(statusText);
}

export function showConfirmModal(onConfirm = () => performDeepCleanse()) {
    const $modal = $('#vrm-confirm-modal');
    const $confirmBtn = $('#vrm-modal-confirm');
    const $cancelBtn = $('#vrm-modal-cancel');

    $modal.css('display', 'flex');
    $confirmBtn.prop('disabled', true).addClass('vrm-is-disabled');

    let timeLeft = 3;
    $confirmBtn.text(`确认清理 (${timeLeft}s)`);

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            $confirmBtn.text(`确认清理 (${timeLeft}s)`);
        } else {
            clearInterval(timer);
            $confirmBtn.prop('disabled', false)
                .removeClass('vrm-is-disabled')
                .text('我已切换，确认清理！');
        }
    }, 1000);

    $cancelBtn.off('click').on('click', () => {
        clearInterval(timer);
        $modal.hide();
    });

    $confirmBtn.off('click').on('click', () => {
        if (!timeLeft) {
            clearInterval(timer);
            $modal.hide();
            onConfirm();
        }
    });
}

export function showRiskConfirmModal(message) {
    return new Promise((resolve) => {
        const $modal = $('#vrm-risk-confirm-modal');
        const finish = (confirmed) => {
            $modal.hide().attr('aria-hidden', 'true');
            $('#vrm-risk-confirm-cancel, #vrm-risk-confirm-ok').off('.vrmRiskConfirm');
            $modal.off('.vrmRiskConfirm');
            resolve(confirmed);
        };

        $('#vrm-risk-confirm-text').text(String(message || ''));
        $modal.css('display', 'flex').attr('aria-hidden', 'false');
        $('#vrm-risk-confirm-cancel').on('click.vrmRiskConfirm', () => finish(false));
        $('#vrm-risk-confirm-ok').on('click.vrmRiskConfirm', () => finish(true));
        $modal.on('click.vrmRiskConfirm', (event) => {
            if (event.target === $modal[0]) finish(false);
        });
    });
}

export function showRiskInfoModal(message) {
    const $modal = $('#vrm-risk-info-modal');
    const close = () => {
        $modal.hide().attr('aria-hidden', 'true');
        $('#vrm-risk-info-close').off('.vrmRiskInfo');
        $modal.off('.vrmRiskInfo');
    };

    $('#vrm-risk-info-text').text(String(message || ''));
    $modal.css('display', 'flex').attr('aria-hidden', 'false');
    $('#vrm-risk-info-close').on('click.vrmRiskInfo', close).trigger('focus');
    $modal.on('click.vrmRiskInfo', (event) => {
        if (event.target === $modal[0]) close();
    });
}

function getAiTimeoutSeconds(timeoutMs) {
    const parsed = Number(timeoutMs);
    const fallback = Number(defaultAiRewriteSettings.timeoutMs) || 120000;
    const normalizedMs = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(Math.max(Math.round(normalizedMs / 1000), 1), 120);
}

function syncPresetAiRewriteGenerationSettingsUI(settings) {
    const aiSettings = {
        ...defaultAiRewriteSettings,
        ...(settings?.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
    };
    const setValueIfNotFocused = (selector, value) => {
        const $field = $(selector);
        if (!$field.is(':focus')) $field.val(value);
    };
    $('#vrm-ai-protect-comments').prop('checked', aiSettings.protectXmlComments === true);
    setValueIfNotFocused('#vrm-ai-temperature', aiSettings.temperature);
    setValueIfNotFocused('#vrm-ai-top-p', aiSettings.topP);
    setValueIfNotFocused('#vrm-ai-top-k', aiSettings.topK);
    setValueIfNotFocused('#vrm-ai-frequency-penalty', aiSettings.frequencyPenalty);
    setValueIfNotFocused('#vrm-ai-presence-penalty', aiSettings.presencePenalty);
    setValueIfNotFocused('#vrm-ai-repetition-penalty', aiSettings.repetitionPenalty);
    setValueIfNotFocused('#vrm-ai-max-tokens', aiSettings.maxTokens);
    setValueIfNotFocused('#vrm-ai-timeout', getAiTimeoutSeconds(aiSettings.timeoutMs));
    setValueIfNotFocused('#vrm-ai-max-retries', aiSettings.maxRetries);
    setValueIfNotFocused('#vrm-ai-max-items', aiSettings.maxItemsPerRequest);
    setValueIfNotFocused('#vrm-ai-max-context', aiSettings.maxContextChars);
    setValueIfNotFocused('#vrm-ai-max-rewrite', aiSettings.maxRewriteCharsPerItem);
    setValueIfNotFocused('#vrm-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
    setValueIfNotFocused('#vrm-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
}

function applyPresetAiRewriteSettings(settings, presetEntry) {
    const presetAiRewrite = getPresetAiRewriteSettings(presetEntry);
    if (!presetAiRewrite) return;
    settings.aiRewrite = {
        ...defaultAiRewriteSettings,
        ...(settings.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
        ...presetAiRewrite,
    };
    syncPresetAiRewriteGenerationSettingsUI(settings);
}

export function applyPresetByName(name, options = {}) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const presetName = String(name || '');
    const presetExists = !!(presetName && settings.presets?.[presetName]);
    const presetEntry = presetExists ? settings.presets[presetName] : null;
    settings.activePreset = presetExists ? presetName : "";
    settings.rules = presetExists ? deepClone(getPresetRules(presetEntry)) : [];
    if (presetExists) applyPresetAiRewriteSettings(settings, presetEntry);
    markRulesDataDirty();
    saveSettingsDebounced();
    logger.info(`切换预设: ${presetName || '(临时规则)'}, 存在=${presetExists}`);
    if (!options.skipRender) {
        updateToolbarUI();
        renderTags();
    }
    if (!options.skipCleanse) performGlobalCleanse();
}

export function cleanupInvalidPresetBindings() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings.presets || {};
    if (settings.defaultPreset && !presets[settings.defaultPreset]) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') {
        settings.characterBindings = {};
    }
    if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};

    Object.keys(settings.characterBindings).forEach((key) => {
        const preset = settings.characterBindings[key];
        if (!preset || !presets[preset]) delete settings.characterBindings[key];
    });
    Object.keys(settings.chatCompletionPresetBindings).forEach((name) => {
        const preset = settings.chatCompletionPresetBindings[name];
        if (!preset || !presets[preset]) delete settings.chatCompletionPresetBindings[name];
    });
}

function formatBindingList(names = []) {
    if (!names.length) return '';
    const shown = names.slice(0, 2).join('、');
    return names.length > 2 ? `${shown} 等 ${names.length} 个` : shown;
}

export function refreshCharacterBindingUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const context = getCurrentCharacterContext();
    const activePreset = String(settings.activePreset || '');
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingResolution = getPresetBindingResolution(context.key, { chatCompletionPresetName });
    const $defaultBtn = $('#vrm-default-toggle');
    const $bindBtn = $('#vrm-character-bind-toggle');
    const $bindCurrentItem = $('#vrm-bind-current-character');
    const $bindChatPresetItem = $('#vrm-bind-current-chat-preset');
    const $unbindItem = $('#vrm-unbind-current-character');
    const currentBound = context.key ? (settings.characterBindings?.[context.key] || '') : '';
    const currentChatBound = chatCompletionPresetName ? (settings.chatCompletionPresetBindings?.[chatCompletionPresetName] || '') : '';
    const activeUsage = getPresetBindingUsage(activePreset);

    if ($defaultBtn.length && $bindBtn.length) {
        const isDefaultActive = !!(activePreset && settings.defaultPreset === activePreset);
        $defaultBtn.toggleClass('vrm-bind-active', isDefaultActive);
        $defaultBtn.prop('disabled', !activePreset);
        $defaultBtn.attr('aria-pressed', String(isDefaultActive));
        $defaultBtn.attr('title', activePreset ? (isDefaultActive ? `已设为全局默认：${activePreset}（点击取消）` : `将当前净化预设设为全局默认：${activePreset}`) : '请先选择一个净化预设');

        const isCharacterBound = !!(context.key && activePreset && currentBound === activePreset);
        const isChatPresetBound = !!(chatCompletionPresetName && activePreset && currentChatBound === activePreset);
        const hasCurrentBinding = !!((context.key && currentBound) || (chatCompletionPresetName && currentChatBound));
        const roleBindingWillSwitchFromChatPreset = !!(activePreset && activeUsage.hasChatCompletionPresetBindings && !isCharacterBound);
        const chatPresetBindingWillSwitchFromRole = !!(activePreset && activeUsage.hasCharacterBindings && !isChatPresetBound);
        $('#vrm-tools-global-preset').text(settings.defaultPreset || '无');
        $('#vrm-tools-chat-binding').text(currentChatBound || '无');
        $('#vrm-tools-character-binding').text(currentBound || '无');
        $bindBtn.toggleClass('vrm-bind-active', hasCurrentBinding);
        $bindBtn.prop('disabled', false);
        $bindBtn.attr('aria-pressed', String(hasCurrentBinding));
        $bindBtn.find('i').removeClass('fa-link-slash').addClass('fa-link');
        $bindBtn.attr('title', !context.key
            ? (currentChatBound ? `绑定管理：当前对话预设已绑定 ${currentChatBound}` : '绑定管理：未检测到当前角色')
            : currentBound
                ? `绑定管理：${context.name} 已绑定 ${currentBound}`
                : currentChatBound
                    ? `绑定管理：对话预设 ${chatCompletionPresetName} 已绑定 ${currentChatBound}`
                    : `绑定管理：当前跟随${bindingResolution.source === 'default' ? '全局默认' : '未绑定状态'}`);

        $bindCurrentItem
            .prop('disabled', !activePreset || !context.key || isCharacterBound)
            .toggleClass('is-active', isCharacterBound);
        $bindCurrentItem.find('.vrm-bind-menu-label').text(isCharacterBound ? '已绑定当前角色' : '绑定当前角色');
        $bindCurrentItem.find('.vrm-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !context.key
                ? '未检测到角色'
                : roleBindingWillSwitchFromChatPreset
                    ? `切换为角色绑定，会移除：${formatBindingList(activeUsage.chatCompletionPresetNames)}`
                    : currentBound && currentBound !== activePreset
                        ? `当前角色已绑定 ${currentBound}，点击改绑`
                        : `使用净化预设：${activePreset}`);

        $bindChatPresetItem
            .prop('disabled', !activePreset || !chatCompletionPresetName || isChatPresetBound)
            .toggleClass('is-active', isChatPresetBound);
        $bindChatPresetItem.find('.vrm-bind-menu-label').text(isChatPresetBound ? '已绑定当前对话补全预设' : '绑定当前对话补全预设');
        $bindChatPresetItem.find('.vrm-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !chatCompletionPresetName
                ? '未检测到 ST 对话补全预设'
                : chatPresetBindingWillSwitchFromRole
                    ? `切换为对话补全预设绑定，会移除角色绑定：${activeUsage.characterKeys.length} 个`
                    : currentChatBound && currentChatBound !== activePreset
                        ? `当前对话预设已绑定 ${currentChatBound}，点击改绑`
                        : `跟随对话预设：${chatCompletionPresetName}`);

        $unbindItem
            .prop('disabled', !currentBound && !currentChatBound)
            .toggleClass('is-active', !!(currentBound || currentChatBound));
        $unbindItem.find('.vrm-bind-menu-label').text(currentBound ? '取消角色绑定' : currentChatBound ? '取消对话预设绑定' : '取消当前绑定');
        $unbindItem.find('.vrm-bind-menu-note').text(currentBound
            ? `当前角色：${currentBound}`
            : currentChatBound
                ? `当前对话预设：${currentChatBound}`
                : '当前没有绑定');

        const syncProxyFieldState = (selector, $target) => {
            const $proxy = $(`#vrm-purifier-popup [data-vrm-click-proxy="${selector}"]`);
            if (!$proxy.length || !$target.length) return;
            const active = $target.hasClass('is-active')
                || $target.hasClass('vrm-bind-active')
                || $target.attr('aria-pressed') === 'true';
            const canToggleActiveBinding = active && $proxy.attr('data-vrm-toggle-binding') === 'true';
            const disabled = $target.prop('disabled') === true && !canToggleActiveBinding;
            const note = String($target.find('.vrm-bind-menu-note').text() || $target.attr('title') || '').trim();
            $proxy
                .attr('aria-disabled', String(disabled))
                .attr('aria-pressed', String(active))
                .toggleClass('is-disabled', disabled)
                .toggleClass('is-active', active)
                .attr('title', note || (disabled ? '当前操作不可用' : '点击执行'));
        };

        syncProxyFieldState('#vrm-default-toggle', $defaultBtn);
        syncProxyFieldState('#vrm-bind-current-character', $bindCurrentItem);
        syncProxyFieldState('#vrm-bind-current-chat-preset', $bindChatPresetItem);
        syncProxyFieldState('#vrm-unbind-current-character', $unbindItem);

        $(`#vrm-purifier-popup [data-vrm-click-proxy="#vrm-default-toggle"] .binding-action-label`)
            .text(isDefaultActive ? '全局已设为此项' : '设为全局预设');
        $(`#vrm-purifier-popup [data-vrm-click-proxy="#vrm-bind-current-chat-preset"] .binding-action-label`)
            .text(isChatPresetBound ? '取消预设绑定' : currentChatBound ? '更换预设绑定' : '绑定到预设');
        $(`#vrm-purifier-popup [data-vrm-click-proxy="#vrm-bind-current-character"] .binding-action-label`)
            .text(isCharacterBound ? '角色卡已绑此项' : currentBound ? '更换角色卡绑定' : '绑定到角色卡');
    }
}

export function applyCharacterPresetBinding(force = false, options = {}) {
    const { extension_settings } = getAppContext();
    const context = getCurrentCharacterContext();
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingSignature = `${context.key || ''}\n${chatCompletionPresetName || ''}`;
    const bindingContextChanged = bindingSignature !== runtimeState.lastPresetBindingSignature;
    if (!force && !bindingContextChanged) return;
    runtimeState.lastCharacterContextKey = context.key;
    runtimeState.lastPresetBindingSignature = bindingSignature;

    const presetName = getPresetForCharacter(context.key, { chatCompletionPresetName });
    if (presetName && presetName !== extension_settings[extensionName].activePreset) {
        applyPresetByName(presetName, { skipRender: true, skipCleanse: options.skipCleanse === true });
    }
    refreshCharacterBindingUI();
}

export function syncRealtimeMaskModeUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    const mode = settings.realtimeMaskMode === 'simple-visual' ? 'simple-visual' : 'tavern-helper';
    const label = mode === 'simple-visual' ? '简单视觉' : '实时渲染';
    const note = mode === 'simple-visual'
        ? '生成中只处理消息显示层文本，不重建代码块或控件。'
        : '生成中只处理酒馆助手显示层文本，不重建代码块或控件。';

    $('#vrm-realtime-mask-label').text(label);
    $('#vrm-realtime-mask-note').text(note);
    $('#vrm-responsive-model-pill').text(mode === 'simple-visual' ? '简单视觉' : '实时渲染');
    $('#vrm-realtime-mask-label, #vrm-responsive-model-pill').attr('title', note);
    $('.vrm-realtime-mask-option').each(function() {
        const active = String($(this).attr('data-mode') || '') === mode;
        $(this)
            .toggleClass('active', active)
            .toggleClass('is-active', active)
            .attr('aria-pressed', String(active));
    });
}

export function updateToolbarUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    cleanupInvalidPresetBindings();
    const selects = $('#vrm-preset-select, #vrm-tools-preset-select');
    if (!selects.length) return;

    if (runtimeState.presetsUiDirty || selects.filter((_, element) => element.children.length === 0).length > 0) {
        const presetNames = settings.presets ? Object.keys(settings.presets) : [];
        const optionsHtml = ['<option value="">-- 临时规则 (未绑定存档) --</option>']
            .concat(presetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`))
            .join('');
        selects.html(optionsHtml);
        markPresetsUiDirty(false);
    }
    selects.val(settings.activePreset || "");
    const rules = Array.isArray(settings.rules) ? settings.rules : [];
    const activePresetLabel = settings.activePreset || '临时规则';
    const aiRuleCount = rules.reduce((count, rule) => count + (Array.isArray(rule?.subRules)
        ? rule.subRules.filter((sub) => sub?.rewriteMode === 'ai').length
        : 0), 0);
    $('#vrm-responsive-preset-title, #vrm-responsive-mobile-preset-title, #vrm-bind-active-preset').text(activePresetLabel);
    $('#vrm-rule-group-count').text(String(rules.length));
    $('#vrm-ai-rule-count').text(String(aiRuleCount));
    syncRealtimeMaskModeUI();
    refreshCharacterBindingUI();
}

export function addRegexReplacementInput(value = '') {
    return appendRegexReplacementInputs([value]).eq(0);
}

export function removeRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const $items = $('#vrm-modal-sub-regex-list').children('.vrm-regex-replacement-chip');
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= $items.length) return;
    const currentEditIndex = getRegexReplacementEditIndex();
    $items.eq(normalizedIndex).remove();
    if (currentEditIndex === normalizedIndex) {
        $('#vrm-modal-sub-rep').data('regex-edit-index', -1);
    } else if (currentEditIndex > normalizedIndex) {
        $('#vrm-modal-sub-rep').data('regex-edit-index', currentEditIndex - 1);
    }
    syncRegexReplacementInputState();
}

export function startEditingRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const values = getRegexReplacementChipValues();
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= values.length) return false;
    $('#vrm-modal-sub-rep').val(values[normalizedIndex]).data('regex-edit-index', normalizedIndex);
    syncRegexReplacementInputState();
    return true;
}

export function recognizeRegexReplacementInput() {
    const $textarea = $('#vrm-modal-sub-rep');
    const draft = String($textarea.val() ?? '');
    if (draft.trim() === '') return { ok: false, reason: 'empty' };

    const editIndex = getRegexReplacementEditIndex();
    const $items = $('#vrm-modal-sub-regex-list').children('.vrm-regex-replacement-chip');
    if (editIndex >= 0 && editIndex < $items.length) {
        const $item = $items.eq(editIndex);
        $item.data('value', draft);
        $item.find('.vrm-regex-replacement-chip-main')
            .html(formatReplacementCandidatePreview(draft))
            .attr('title', draft || '点击编辑替换项');
        $textarea.val('').data('regex-edit-index', -1);
        syncRegexReplacementInputState();
        return { ok: true, mode: 'update' };
    }

    const lines = draft.replace(/\r/g, '').split('\n').map((line) => (line.trim() === '' ? '' : line));
    if (lines.length === 0) return { ok: false, reason: 'empty' };
    appendRegexReplacementInputs(lines, { sync: false });
    $textarea.val('').data('regex-edit-index', -1);
    syncRegexReplacementInputState();
    return { ok: true, mode: 'append', count: lines.length };
}

export function hasPendingRegexReplacementInput() {
    const draft = String($('#vrm-modal-sub-rep').val() ?? '');
    if (draft.trim() === '') return false;
    const editIndex = getRegexReplacementEditIndex();
    const values = getRegexReplacementChipValues();
    return editIndex < 0 || editIndex >= values.length || draft !== values[editIndex];
}

export function setSingleRuleReplacementEditor(mode, replacements = []) {
    const normalized = normalizeReplacementList(replacements);
    const isRegexMode = mode === 'regex';
    const $textarea = $('#vrm-modal-sub-rep');
    const $actions = $('#vrm-modal-sub-regex-actions');
    const $list = $('#vrm-modal-sub-regex-list');
    $textarea.data('regex-edit-index', -1);

    if (isRegexMode) {
        $textarea.val('');
        $list.empty();
        appendRegexReplacementInputs(normalized, { sync: false });
        $actions.prop('hidden', false);
        syncRegexReplacementInputState();
        return;
    }

    $list.empty().prop('hidden', true);
    $actions.prop('hidden', true);
    $textarea
        .val(normalized.join(mode === 'text' ? ', ' : '\n'))
        .removeData('regex-default-placeholder')
        .removeData('regex-edit-placeholder');
}

export function getSingleRuleReplacementValues(mode) {
    if (mode === 'regex') {
        return getRegexReplacementChipValues();
    }

    const rawValue = String($('#vrm-modal-sub-rep').val() ?? '');
    return parseInputToWords(rawValue, mode === 'text' ? 'text' : 'regex', { isTarget: false });
}

export function renderTags() {
    const container = $('#vrm-tags-container');
    if (!container.length) return;
    if (!runtimeState.rulesUiDirty && container.children().length > 0) return;

    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];
    const html = rules.map((r, i) => {
        const name = safeHtml(r.name) || `未命名合集 ${i + 1}`;
        const subRules = r.subRules || [];
        const maxPreview = 3;

        const subRulesHtml = subRules.slice(0, maxPreview).map((sub) => {
            const mode = sub.mode || 'text';
            const tagText = getRulePreviewTagText(mode);
            const tPreview = getRuleSourcePreviewText(sub);
            const rPreview = getRewriteMode(sub) === 'ai'
                ? 'AI 运行时生成'
                : formatReplacementPreview(sub.replacements || [], mode);
            const subEnabled = sub.enabled !== false;
            const rewriteBadge = getRewriteModeBadgeHtml(sub);
            return `
                <div class="vrm-rule-item ${subEnabled ? '' : 'vrm-is-disabled'}">
                    <div class="vrm-rule-source">
                        <div class="vrm-rule-labels">
                            <span class="vrm-tag">${tagText}</span>
                            ${rewriteBadge}
                        </div>
                        <span class="vrm-source">${tPreview}</span>
                    </div>
                    <i class="fas fa-arrow-right vrm-arrow"></i>
                    <div class="vrm-rule-target">
                        <span class="vrm-preview-label">改写预览</span>
                        <span class="vrm-target">${rPreview}</span>
                    </div>
                </div>`;
        }).join('');

        const moreHtml = subRules.length > maxPreview
            ? `<div class="vrm-more-text">... 以及其他 ${subRules.length - maxPreview} 组映射</div>`
            : '';
        const bodyHtml = subRules.length > 0
            ? `<div class="vrm-card-body">${subRulesHtml}${moreHtml}</div>`
            : '';

        const isEnabled = r.enabled !== false;
        const riskIndicatorHtml = isRuleActivationWarningEnabled(r)
            ? `<i class="fas fa-circle-exclamation vrm-rule-risk-indicator"
                  data-index="${i}"
                  title="查看启用风险提示"
                  aria-label="查看高风险规则组提示"
                  role="button"
                  tabindex="0"></i>`
            : '';
        const checkedAttr = isEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rules.length - 1 ? 'disabled' : '';
        const headerClass = subRules.length > 0 ? 'vrm-card-header vrm-has-border' : 'vrm-card-header';

        return `
            <div class="vrm-card ${!isEnabled ? 'vrm-is-disabled' : ''}" data-index="${i}">
                <div class="${headerClass}">
                    <div class="vrm-header-left">
                        <label class="vrm-batch-checkbox-label">
                            <input type="checkbox" class="vrm-batch-item-checkbox" data-index="${i}">
                            <span class="vrm-custom-checkbox vrm-square-2px"></span>
                        </label>
                        <label class="vrm-checkbox-label" title="启用或停用此规则组">
                            <input type="checkbox" class="vrm-rule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="vrm-custom-checkbox"></span>
                            <span class="vrm-group-title">${name}</span>
                            <span class="vrm-rule-count">${subRules.length} 条</span>
                        </label>
                    </div>
                    <div class="vrm-icon-group vrm-compact">
                        <button class="vrm-rule-move-up" data-index="${i}" title="上移合集" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button class="vrm-rule-move-down" data-index="${i}" title="下移合集" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        ${riskIndicatorHtml}
                        <button class="vrm-rule-edit" type="button" data-index="${i}" title="打开合集" aria-label="打开合集"><i class="fas fa-ellipsis-vertical"></i></button>
                    </div>
                </div>
                ${bodyHtml}
            </div>`;
    }).join('');

    container.html(html || '<div class="vrm-empty-state">当前无规则，请点击上方按钮新增</div>');
    const aiRuleCount = rules.reduce((count, rule) => count + (Array.isArray(rule?.subRules)
        ? rule.subRules.filter((sub) => sub?.rewriteMode === 'ai').length
        : 0), 0);
    $('#vrm-rule-group-count').text(String(rules.length));
    $('#vrm-ai-rule-count').text(String(aiRuleCount));
    markRulesUiDirty(false);
}

export function renderSubrulesToModal() {
    const container = $('#vrm-edit-subrules-container');
    if (!container.length) return;
    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--vrm-text-secondary); font-size:12px; padding:20px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    const html = runtimeState.currentEditingSubrules.map((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const subEnabled = sub.enabled !== false;
        const checkedAttr = subEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeBaseStyle = "display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:800; color:#fff; min-width:45px; margin:0; line-height:1; flex-shrink:0;";
        let badgeHTML = '';
        if (mode === 'regex') badgeHTML = `<span style="${badgeBaseStyle} background:var(--vrm-accent-color);">正则</span>`;
        else if (mode === 'simple') badgeHTML = `<span style="${badgeBaseStyle} background:color-mix(in srgb, var(--vrm-accent-color) 72%, #3b82f6 28%);">简易</span>`;
        else badgeHTML = `<span style="${badgeBaseStyle} background:var(--vrm-text-secondary); color:var(--vrm-background-popup);">普通</span>`;

        const tPreview = getRuleSourcePreviewText(sub);
        const rPreview = formatReplacementPreview(sub.replacements || [], mode);
        const rewriteBadge = getRewriteModeBadgeHtml(sub);

        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted color-mix(in srgb, var(--vrm-text-primary) 35%, rgba(128,128,128,0.5)); font-size: 11px; color: var(--vrm-text-mute); font-style: italic;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>${safeHtml(remark)}
                </div>
            `;
        }

        return `
            <div class="vrm-subrule-card ${subEnabled ? '' : 'vrm-is-disabled'}" style="flex-shrink: 0 !important; background: var(--vrm-background-secondary); border: 1px solid var(--vrm-border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dotted color-mix(in srgb, var(--vrm-text-primary) 35%, rgba(128,128,128,0.5));">
                    <div style="display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; min-width: 0;">
                        <label class="vrm-checkbox-label vrm-subrule-enable-label" title="${subEnabled ? '停用此条规则' : '启用此条规则'}">
                            <input type="checkbox" class="vrm-subrule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="vrm-custom-checkbox"></span>
                        </label>
                        ${badgeHTML}
                        ${rewriteBadge}
                    </div>
                    <div class="vrm-subrule-btn-group" style="display: flex; justify-content: space-between; align-items: center; flex: 0 0 35%; margin: 0; padding: 0;">
                        <button class="vrm-move-subrule-up-btn vrm-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled} style="margin:0;"><i class="fas fa-arrow-up"></i></button>
                        <button class="vrm-move-subrule-down-btn vrm-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled} style="margin:0;"><i class="fas fa-arrow-down"></i></button>
                        <button class="vrm-edit-subrule-btn vrm-icon-btn" data-index="${i}" title="独立编辑" style="margin:0;"><i class="fas fa-pen"></i></button>
                        <button class="vrm-del-subrule-btn vrm-icon-btn vrm-danger-btn" data-index="${i}" title="删除" style="margin:0;"><i class="fas fa-trash"></i></button>
                        <button class="vrm-remark-subrule-btn vrm-icon-btn" data-index="${i}" title="快捷修改备注" style="margin:0;"><i class="fas fa-comment-dots"></i></button>
                    </div>
                </div>
                <div style="font-size: 13px !important; color: var(--vrm-text-primary); line-height: 1.5; word-break: break-all;">
                    <b style="font-size: 13px !important;">${tPreview}</b>
                    <i class="fas fa-arrow-right" style="color: var(--vrm-text-mute); font-size: 11px; margin: 0 6px;"></i>
                    <span style="font-size: 13px !important;">${rPreview}</span>
                </div>
                ${remarkHTML}
            </div>
        `;
    }).join('');

    container.html(html);
}

export function openSingleRuleModal(index, options = {}) {
    runtimeState.currentSubruleEditIndex = index;
    let mode = 'simple';
    let tStr = '';
    let replacements = [];
    let remark = '';
    let rewriteMode = 'program';
    let aiPromptTemplate = '';

    if (index >= 0 && runtimeState.currentEditingSubrules[index]) {
        const sub = runtimeState.currentEditingSubrules[index];
        mode = sub.mode || 'simple';
        tStr = (sub.targets || []).join(mode === 'text' ? ', ' : '\n');
        replacements = Array.isArray(sub.replacements) ? sub.replacements : [];
        remark = sub.remark || '';
        rewriteMode = getRewriteMode(sub);
        aiPromptTemplate = String(sub.aiPromptTemplate || '');
    }

    $('#vrm-modal-sub-mode').val(mode).data('current-mode', mode);
    $('#vrm-modal-sub-rewrite-mode').val(rewriteMode);
    $('#vrm-modal-sub-target').val(tStr);
    setSingleRuleReplacementEditor(mode, replacements);
    $('#vrm-modal-sub-remark').val(remark);
    $('#vrm-modal-sub-ai-prompt').val(aiPromptTemplate);

    $('#vrm-modal-sub-mode').trigger('change');
    $('#vrm-modal-sub-rewrite-mode').trigger('change');
    if (options.hideEditModal === true) $('#vrm-rule-edit-modal').hide();
    $('#vrm-subrule-edit-modal').css('display', 'flex').hide().fadeIn(150);
}

export function openTransferModal(ruleIndexOrIndexes) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const currentPreset = settings?.activePreset || "";
    const targetNames = Object.keys(presets).filter(name => name !== currentPreset);
    if (targetNames.length === 0) {
        alert('没有可用的目标存档。请先创建至少一个其他存档。');
        return;
    }

    const indexes = Array.isArray(ruleIndexOrIndexes) ? ruleIndexOrIndexes : [ruleIndexOrIndexes];
    runtimeState.currentTransferRuleIndexes = indexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    runtimeState.currentTransferRuleIndex = runtimeState.currentTransferRuleIndexes[0] ?? -1;
    const $select = $('#vrm-transfer-target');
    $select.html(targetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`).join(''));
    $('#vrm-rule-transfer-modal').css('display', 'flex');
}

export function closeTransferModal() {
    runtimeState.currentTransferRuleIndex = -1;
    runtimeState.currentTransferRuleIndexes = [];
    $('#vrm-rule-transfer-modal').hide();
}

export function runRuleTransfer(isMove) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#vrm-transfer-target').val() || '');
    const sourcePreset = String(settings.activePreset || '');
    const transferIndexes = Array.isArray(runtimeState.currentTransferRuleIndexes) && runtimeState.currentTransferRuleIndexes.length > 0
        ? runtimeState.currentTransferRuleIndexes
        : [runtimeState.currentTransferRuleIndex];
    const validIndexes = transferIndexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    if (validIndexes.length === 0) return;
    if (!targetPreset) {
        alert('请选择目标存档。');
        return;
    }
    if (targetPreset === sourcePreset) {
        closeTransferModal();
        return;
    }

    const sourceRules = settings.rules || [];
    const uniqueIndexes = [...new Set(validIndexes)].sort((a, b) => a - b).filter((idx) => idx < sourceRules.length);
    if (uniqueIndexes.length === 0) {
        closeTransferModal();
        return;
    }

    const targetEntry = settings.presets[targetPreset];
    const targetRules = deepClone(getPresetRules(targetEntry));
    const movingRules = uniqueIndexes.map((idx) => sourceRules[idx]).filter(Boolean);
    movingRules.forEach((rule) => targetRules.push(deepClone(rule)));
    settings.presets[targetPreset] = buildPresetEntry(
        targetRules,
        getPresetAiRewriteSettings(targetEntry) || getCurrentPresetAiRewriteSettings(settings.aiRewrite)
    );
    if (isMove) {
        for (let i = uniqueIndexes.length - 1; i >= 0; i--) {
            sourceRules.splice(uniqueIndexes[i], 1);
        }
        runtimeState.batchSelectedRuleIds = [];
        markRulesDataDirty();
    }

    closeTransferModal();
    saveSettingsDebounced();
    if (isMove) renderTags();
}

export function openEditModal(index = -1, options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const { source = 'main', returnMode = 'group', subRuleIndex = -1 } = options;
    runtimeState.currentEditingIndex = index;
    if (source === 'search') {
        runtimeState.searchEditFlow.active = true;
        runtimeState.searchEditFlow.returnMode = returnMode;
        runtimeState.searchEditFlow.ruleIndex = index;
        runtimeState.searchEditFlow.subRuleIndex = subRuleIndex;
    } else {
        clearRuleSearchEditFlow();
    }
    const modal = $('#vrm-rule-edit-modal');

    if (index === -1) {
        $('#vrm-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#vrm-edit-name').val('');
        runtimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', enabled: true, isEditing: false }];
    } else {
        const rule = settings.rules[index];
        $('#vrm-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#vrm-edit-name').val(rule.name || '');
        runtimeState.currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        runtimeState.currentEditingSubrules.forEach(sub => {
            if (sub.enabled === undefined) sub.enabled = true;
            sub.isEditing = false;
        });
    }

    renderSubrulesToModal();
    modal.css('display', 'flex');
}
