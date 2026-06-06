import {EventRef, ItemView, Notice, TFile, WorkspaceLeaf} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {Claim, Excerpt} from '../core/types';
import {LinkToClaimModal} from './LinkToClaimModal';
import {EditExcerptModal} from './EditExcerptModal';
import {GraphView} from './GraphView';

export const VIEW_TYPE_WORKSPACE = 'excerpt-workspace';

type Tab = 'claims' | 'excerpts' | 'graph' | 'rsl' | 'compare';
type Filter = 'current-pdf' | 'all';

export class WorkspaceView extends ItemView {
	private plugin: ExcerptManagerPlugin;
	private activeTab: Tab = 'excerpts';
	private activeFilter: Filter = 'current-pdf';

	private tabContents: Record<Tab, HTMLElement> = {} as Record<Tab, HTMLElement>;
	private tabButtons: Record<Tab, HTMLElement> = {} as Record<Tab, HTMLElement>;
	private filterButtons: Record<Filter, HTMLElement> = {} as Record<Filter, HTMLElement>;
	private filterRow: HTMLElement;

	private eventRefs: EventRef[] = [];
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	// Memoization
	private lastActiveFilePath: string | null = null;
	private lastExcerptHash = '';
	private lastClaimHash = '';

	// Search/filter state
	private searchText = '';
	private filterTag = '';
	private filterClaimId = '';
	private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Graph view
	private graphView: GraphView | null = null;

	// Compare state (transient, in-memory)
	private comparedExcerptIds: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, plugin: ExcerptManagerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_WORKSPACE; }
	getDisplayText(): string { return 'Excerpt Workspace'; }
	getIcon(): string { return 'book-open'; }

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('excerpt-workspace');

		const header = root.createDiv({cls: 'excerpt-header'});

		const tabBar = header.createDiv({cls: 'excerpt-tab-bar'});
		const tabs: {id: Tab; label: string}[] = [
			{id: 'excerpts', label: 'Excerpts'},
			{id: 'claims',   label: 'Claims'},
			{id: 'compare',  label: 'Compare'},
			{id: 'graph',    label: 'Graph'},
			{id: 'rsl',      label: 'RSL'},
		];
		tabs.forEach(({id, label}) => {
			const btn = tabBar.createEl('button', {
				cls: 'excerpt-tab-btn' + (id === this.activeTab ? ' active' : ''),
				text: label,
			});
			this.tabButtons[id] = btn;
			btn.addEventListener('click', () => this.setTab(id));
		});

		this.filterRow = header.createDiv({cls: 'excerpt-scope-toggle'});
		if (this.activeTab !== 'excerpts') this.filterRow.style.display = 'none';
		(['current-pdf', 'all'] as Filter[]).forEach(f => {
			const btn = this.filterRow.createEl('button', {
				cls: 'excerpt-scope-btn' + (f === this.activeFilter ? ' active' : ''),
				text: f === 'current-pdf' ? 'This source' : 'All',
			});
			this.filterButtons[f] = btn;
			btn.addEventListener('click', () => this.setFilter(f));
		});

		const contentArea = root.createDiv({cls: 'excerpt-tab-content'});
		tabs.forEach(({id}) => {
			const pane = contentArea.createDiv({cls: 'excerpt-tab-pane'});
			if (id !== this.activeTab) pane.style.display = 'none';
			this.tabContents[id] = pane;
		});

		this.eventRefs.push(
			this.app.workspace.on('active-leaf-change', () => {
				this.lastActiveFilePath = null;
				this.scheduleRefresh();
			}),
			this.app.vault.on('create',  () => this.scheduleRefresh()),
			this.app.vault.on('modify',  () => this.scheduleRefresh()),
			this.app.vault.on('delete',  () => this.scheduleRefresh()),
		);

		this.renderActiveTab();
	}

	async onClose(): Promise<void> {
		this.eventRefs.forEach(ref => this.app.workspace.offref(ref));
		this.eventRefs = [];
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		if (this.graphView) {
			this.graphView.destroy();
			this.graphView = null;
		}
	}

	// --- Refresh ---

	private scheduleRefresh(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			const activeFile = this.app.workspace.getActiveFile();
			const activeFilePath = activeFile?.path ?? null;

			if (activeFilePath === this.lastActiveFilePath) {
				const newExcerptHash = this.computeExcerptHash();
				const newClaimHash = this.computeClaimHash();
				if (
					newExcerptHash === this.lastExcerptHash &&
					newClaimHash === this.lastClaimHash
				) return;
				this.lastExcerptHash = newExcerptHash;
				this.lastClaimHash = newClaimHash;
			} else {
				this.lastActiveFilePath = activeFilePath;
				this.lastExcerptHash = this.computeExcerptHash();
				this.lastClaimHash = this.computeClaimHash();
			}

			this.renderActiveTab();
		}, 500);
	}

	private computeExcerptHash(): string {
		return this.plugin.store.listExcerpts().map(e => e.id + e.relations.length).join('|');
	}

	private computeClaimHash(): string {
		return this.plugin.claimStore.listClaims().map(c => c.id).join('|');
	}

	private renderActiveTab(): void {
		if (this.activeTab === 'claims')   this.renderClaimsTab(this.tabContents['claims']);
		if (this.activeTab === 'excerpts') this.renderExcerptsTab(this.tabContents['excerpts']);
		if (this.activeTab === 'graph')    this.renderGraphTab(this.tabContents['graph']);
		if (this.activeTab === 'rsl')      void this.renderRslTab(this.tabContents['rsl']);
		if (this.activeTab === 'compare')  this.renderCompareTab(this.tabContents['compare']);
	}

	// --- Claims tab ---

	private renderClaimsTab(container: HTMLElement): void {
		container.empty();

		const inputRow = container.createDiv({cls: 'excerpt-new-claim-row'});
		const input = inputRow.createEl('input', {
			cls: 'excerpt-new-claim-input',
			type: 'text',
			placeholder: 'New claim...',
		});
		const createBtn = inputRow.createEl('button', {cls: 'excerpt-new-claim-btn', text: 'Create'});

		const doCreate = async () => {
			const label = input.value.trim();
			if (!label) return;
			try {
				const claim = await this.plugin.claimStore.createClaim(label);
				input.value = '';
				await this.app.workspace.openLinkText(
					`${this.plugin.settings.claimFolder}/${claim.id}`, '', false
				);
				this.renderClaimsTab(container);
			} catch (e) {
				console.error('Failed to create claim:', e);
			}
		};

		createBtn.addEventListener('click', () => void doCreate());
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doCreate(); });

		const claims = this.plugin.claimStore.listClaims();

		if (claims.length === 0) {
			container.createEl('p', {
				text: 'No claims yet. Type a claim above and press Create.',
				cls: 'excerpt-empty-state',
			});
			return;
		}

		claims.forEach(claim => container.appendChild(this.createClaimCard(claim)));
	}

	private getExcerptPdfLinktext(excerpt: Excerpt): string {
		const paperFile = this.app.vault.getAbstractFileByPath(excerpt.source + '.md')
			?? this.app.vault.getAbstractFileByPath(excerpt.source);
		if (paperFile instanceof TFile) {
			const paper = this.plugin.paperStore.readPaper(paperFile);
			if (paper?.pdfPath) {
				const fragment = excerpt.selectionRange
					? `#page=${excerpt.page}&selection=${excerpt.selectionRange}`
					: `#page=${excerpt.page}`;
				return paper.pdfPath + fragment;
			}
		}
		return `${this.plugin.settings.excerptFolder}/${excerpt.id}`;
	}

	private resolveCurrentSourcePath(): string | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return null;

		if (activeFile.extension === 'pdf') {
			const paper = this.plugin.paperStore.listPapers()
				.find(p => p.pdfPath === activeFile.path);
			return paper ? `${this.plugin.settings.paperFolder}/${paper.id}` : null;
		}

		if (activeFile.extension === 'md') {
			const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
			if (fm?.['type'] === 'excerpt') {
				const raw = String(fm['source'] ?? '');
				return raw.replace(/^\[\[/, '').replace(/\]\]$/, '') || null;
			}
			return activeFile.path.replace(/\.md$/, '');
		}

		return null;
	}

	// --- Format helpers ---

	private formatExcerptForInsert(excerpt: Excerpt): string {
		const paperFile = this.app.vault.getAbstractFileByPath(excerpt.source + '.md')
			?? this.app.vault.getAbstractFileByPath(excerpt.source);
		const paper = paperFile instanceof TFile ? this.plugin.paperStore.readPaper(paperFile) : null;
		const title = paper?.title || excerpt.source.split('/').pop() || 'Source';
		const citation = `[[${excerpt.source}|${title}]], p. ${excerpt.page}`;
		const lines = (excerpt.selectionText || '').trim().split('\n')
			.filter(l => l.trim())
			.map(l => `> ${l}`).join('\n') || '>';
		return `${lines}\n>\n> — *${citation}*`;
	}

	private formatClaimForInsert(claim: Claim): string {
		return `[[${this.plugin.settings.claimFolder}/${claim.id}|${claim.label}]]`;
	}

	private formatClaimAsSection(claim: Claim, linkedExcerpts: Excerpt[]): string {
		let md = `## ${claim.label}\n\n`;
		if (claim.description) md += `${claim.description}\n\n`;

		for (const excerpt of linkedExcerpts) {
			const rel = excerpt.relations.find(r => r.target.split('/').pop() === claim.id);
			if (rel) md += `*${rel.type}*\n\n`;
			md += this.formatExcerptForInsert(excerpt) + '\n\n---\n\n';
		}
		return md.trimEnd() + '\n';
	}

	// --- Claim card ---

	private createClaimCard(claim: Claim): HTMLElement {
		const card = createEl('div', {cls: 'excerpt-card excerpt-claim-card'});

		this.makeDragHandle(card, 'Drag into a note to insert link', () => this.formatClaimForInsert(claim));

		const body = card.createDiv({cls: 'excerpt-card-body'});
		const header = body.createDiv({cls: 'excerpt-claim-card-header'});
		const labelEl = header.createEl('div', {cls: 'excerpt-card-label', text: claim.label});
		const headerActions = header.createDiv({cls: 'excerpt-claim-header-actions'});

		// Copy wikilink
		const copyBtn = headerActions.createEl('span', {cls: 'excerpt-claim-action', text: 'Copy'});
		copyBtn.title = 'Copy as wikilink';
		copyBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			await navigator.clipboard.writeText(this.formatClaimForInsert(claim));
			this.flashCopied(copyBtn, 'Copy');
		});

		// Export claim as draft section
		const exportBtn = headerActions.createEl('span', {cls: 'excerpt-claim-action', text: 'Export'});
		exportBtn.title = 'Export claim and all its excerpts as formatted markdown';
		exportBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			const linkedExcerpts = this.plugin.store.listExcerpts().filter(ex =>
				ex.relations.some(r => r.target.split('/').pop() === claim.id)
			);
			if (linkedExcerpts.length === 0) {
				new Notice('No excerpts linked to this claim.');
				return;
			}
			const md = this.formatClaimAsSection(claim, linkedExcerpts);
			await navigator.clipboard.writeText(md);
			this.flashCopied(exportBtn, 'Export');
		});

		// Edit label inline
		const editBtn = headerActions.createEl('span', {cls: 'excerpt-claim-action', text: 'Edit'});
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const input = createEl('input', {cls: 'excerpt-new-claim-input', type: 'text'}) as HTMLInputElement;
			input.value = claim.label;
			labelEl.replaceWith(input);
			editBtn.style.display = 'none';
			input.focus();
			input.select();

			const save = async () => {
				const newLabel = input.value.trim();
				if (newLabel && newLabel !== claim.label) {
					try {
						await this.plugin.claimStore.updateLabel(claim.id, newLabel);
						this.renderClaimsTab(this.tabContents['claims']);
					} catch (err) {
						new Notice((err as Error).message);
					}
				} else {
					input.replaceWith(labelEl);
					editBtn.style.display = '';
				}
			};

			input.addEventListener('blur', () => void save());
			input.addEventListener('keydown', (ev) => {
				if (ev.key === 'Enter') void save();
				if (ev.key === 'Escape') { input.replaceWith(labelEl); editBtn.style.display = ''; }
			});
		});

		const deleteBtn = headerActions.createEl('span', {cls: 'excerpt-claim-action excerpt-claim-action-delete', text: 'Delete'});
		deleteBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			try {
				await this.plugin.claimStore.deleteClaim(claim.id);
				this.renderClaimsTab(this.tabContents['claims']);
			} catch (err) {
				new Notice((err as Error).message);
			}
		});

		if (claim.tags.length > 0) {
			body.createEl('div', {
				cls: 'excerpt-card-source',
				text: claim.tags.map(t => `#${t}`).join(' '),
			});
		}

		const linkedExcerpts = this.plugin.store.listExcerpts().filter(e =>
			e.relations.some(r => r.target.split('/').pop() === claim.id)
		);

		if (linkedExcerpts.length > 0) {
			const excerptSection = body.createDiv({cls: 'excerpt-claim-excerpts'});

			const toggle = excerptSection.createEl('div', {cls: 'excerpt-claim-excerpts-toggle'});
			toggle.createEl('span', {cls: 'excerpt-claim-excerpts-chevron', text: '▸'});
			toggle.createEl('span', {text: ` ${linkedExcerpts.length} excerpt${linkedExcerpts.length > 1 ? 's' : ''}`});

			const list = excerptSection.createDiv({cls: 'excerpt-claim-excerpts-list'});
			list.style.display = 'none';

			linkedExcerpts.forEach(excerpt => {
				const row = list.createDiv({cls: 'excerpt-claim-excerpt-row'});

				const rel = excerpt.relations.find(r => r.target.split('/').pop() === claim.id);
				const color = rel
					? (this.plugin.settings.relationTypes.find(rt => rt.name === rel.type)?.color ?? '#888')
					: '#888';

				const rowTop = row.createDiv({cls: 'excerpt-claim-excerpt-row-top'});
				const badge = rowTop.createEl('span', {cls: 'excerpt-badge', text: rel?.type ?? ''});
				badge.style.backgroundColor = color;
				rowTop.createEl('span', {cls: 'excerpt-claim-excerpt-label', text: excerpt.label});

				if (excerpt.selectionText) {
					const preview = excerpt.selectionText.length > 120
						? excerpt.selectionText.slice(0, 120).trimEnd() + '…'
						: excerpt.selectionText;
					row.createEl('div', {cls: 'excerpt-claim-excerpt-preview', text: preview});
				}

				const removeBtn = row.createEl('span', {cls: 'excerpt-claim-excerpt-remove', text: '×'});
				removeBtn.title = 'Remove from claim';
				removeBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					const updated = excerpt.relations.filter(r => r.target.split('/').pop() !== claim.id);
					await this.plugin.store.updateRelations(excerpt.id, updated);
					this.renderClaimsTab(this.tabContents['claims']);
				});

				row.addEventListener('click', (e) => {
					e.stopPropagation();
					void this.app.workspace.openLinkText(
						`${this.plugin.settings.excerptFolder}/${excerpt.id}`, '', false
					);
				});
			});

			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				const open = list.style.display !== 'none';
				list.style.display = open ? 'none' : '';
				toggle.querySelector('.excerpt-claim-excerpts-chevron')!.textContent = open ? '▸' : '▾';
			});
		}

		let claimHoverTimer: ReturnType<typeof setTimeout> | null = null;
		card.addEventListener('mouseenter', (e) => {
			const {clientX, clientY} = e;
			claimHoverTimer = setTimeout(() => {
				this.app.workspace.trigger('hover-link', {
					event: new MouseEvent('mouseover', {clientX, clientY, bubbles: true}),
					source: 'excerpt-manager',
					hoverParent: this,
					targetEl: card,
					linktext: `${this.plugin.settings.claimFolder}/${claim.id}`,
					sourcePath: '',
				});
			}, 1200);
		});
		card.addEventListener('mouseleave', () => {
			if (claimHoverTimer) { clearTimeout(claimHoverTimer); claimHoverTimer = null; }
		});

		body.addEventListener('click', () => {
			void this.app.workspace.openLinkText(
				`${this.plugin.settings.claimFolder}/${claim.id}`, '', false
			);
		});

		return card;
	}

	// --- Excerpts tab ---

	private renderExcerptsTab(container: HTMLElement): void {
		container.empty();

		let excerpts: Excerpt[];

		if (this.activeFilter === 'all') {
			excerpts = this.plugin.store.listExcerpts();
		} else {
			const sourcePath = this.resolveCurrentSourcePath();
			if (!sourcePath) {
				container.createEl('p', {text: 'Open a source to see its excerpts.', cls: 'excerpt-empty-state'});
				return;
			}
			excerpts = this.plugin.store.listExcerptsBySource(sourcePath);
		}

		const filterBar = container.createDiv({cls: 'excerpt-filter-bar'});

		const searchInput = filterBar.createEl('input', {
			cls: 'excerpt-search-input',
			type: 'text',
			placeholder: 'Search excerpts...',
		}) as HTMLInputElement;
		searchInput.value = this.searchText;

		const allTags = Array.from(new Set(excerpts.flatMap(e => e.tags))).sort();
		const tagSelect = filterBar.createEl('select', {cls: 'excerpt-filter-select'}) as HTMLSelectElement;
		tagSelect.createEl('option', {value: '', text: 'All tags'});
		allTags.forEach(tag => tagSelect.createEl('option', {value: tag, text: tag}));
		tagSelect.value = this.filterTag;

		const allClaims = this.plugin.claimStore.listClaims();
		const claimSelect = filterBar.createEl('select', {cls: 'excerpt-filter-select'}) as HTMLSelectElement;
		claimSelect.createEl('option', {value: '', text: 'All claims'});
		allClaims.forEach(c => claimSelect.createEl('option', {value: c.id, text: c.label}));
		claimSelect.value = this.filterClaimId;

		const cardList = container.createDiv();
		const resultCountEl = container.createDiv({cls: 'excerpt-result-count'});
		container.insertBefore(resultCountEl, cardList);

		const renderCards = () => {
			cardList.empty();

			const search = this.searchText.toLowerCase();
			let filtered = excerpts;

			if (search) filtered = filtered.filter(e =>
				e.label.toLowerCase().includes(search) ||
				e.selectionText.toLowerCase().includes(search)
			);
			if (this.filterTag) filtered = filtered.filter(e => e.tags.includes(this.filterTag));
			if (this.filterClaimId) filtered = filtered.filter(e =>
				e.relations.some(r => r.target.split('/').pop() === this.filterClaimId)
			);

			resultCountEl.setText(`${filtered.length} of ${excerpts.length} excerpts`);

			if (filtered.length === 0) {
				cardList.createEl('p', {
					text: excerpts.length === 0
						? (this.activeFilter === 'all'
							? 'No excerpts yet. Open a PDF or note and select text to get started.'
							: 'No excerpts yet for this source. Select text to create one.')
						: 'No excerpts match the current filters.',
					cls: 'excerpt-empty-state',
				});
				return;
			}

			filtered.forEach(excerpt => cardList.appendChild(this.createExcerptCard(excerpt)));
		};

		searchInput.addEventListener('input', () => {
			if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = setTimeout(() => {
				this.searchText = searchInput.value.toLowerCase();
				renderCards();
			}, 300);
		});

		tagSelect.addEventListener('change', () => { this.filterTag = tagSelect.value; renderCards(); });
		claimSelect.addEventListener('change', () => { this.filterClaimId = claimSelect.value; renderCards(); });

		renderCards();
	}

	// --- Excerpt card ---

	private makeDragHandle(parent: HTMLElement, title: string, getText: () => string): void {
		const handle = parent.createDiv({cls: 'excerpt-drag-handle'});
		handle.setAttribute('draggable', 'true');
		handle.title = title;
		handle.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			e.dataTransfer?.setData('text/plain', getText());
		});
		handle.addEventListener('click', (e) => e.stopPropagation());
	}

	private flashCopied(el: HTMLElement, original: string): void {
		el.textContent = 'Copied';
		setTimeout(() => { el.textContent = original; }, 1800);
	}

	private createExcerptCard(excerpt: Excerpt): HTMLElement {
		const card = createEl('div', {cls: 'excerpt-card'});

		this.makeDragHandle(card, 'Drag into a note to insert citation', () => this.formatExcerptForInsert(excerpt));

		const body = card.createDiv({cls: 'excerpt-card-body'});

		body.createEl('div', {cls: 'excerpt-card-label', text: excerpt.label});

		if (excerpt.imagePath) {
			const imgFile = this.app.vault.getAbstractFileByPath(excerpt.imagePath);
			if (imgFile instanceof TFile) {
				const img = body.createEl('img', {cls: 'excerpt-card-image'});
				img.src = this.app.vault.getResourcePath(imgFile);
			}
		}

		const sourceName = excerpt.source.split('/').pop() ?? excerpt.source;
		body.createEl('div', {
			cls: 'excerpt-card-source',
			text: excerpt.page > 0 ? `${sourceName}  ·  p. ${excerpt.page}` : sourceName,
		});

		if (excerpt.selectionText) {
			const previewText = excerpt.selectionText.length > 650
				? excerpt.selectionText.slice(0, 650).trimEnd() + '…'
				: excerpt.selectionText;
			const previewEl = body.createEl('div', {cls: 'excerpt-card-preview', text: previewText});
			previewEl.addEventListener('mousedown', (e) => e.stopPropagation());
		}

		if (excerpt.relations.length > 0) {
			const claimMap = new Map(this.plugin.claimStore.listClaims().map(c => [c.id, c.label]));
			const badgesContainer = body.createDiv({cls: 'excerpt-claim-badges'});

			excerpt.relations.forEach(rel => {
				const claimId    = rel.target.split('/').pop() ?? '';
				const claimLabel = claimMap.get(claimId);
				const color      = this.plugin.settings.relationTypes
					.find(rt => rt.name === rel.type)?.color ?? '#888';

				const row = badgesContainer.createDiv({cls: 'excerpt-claim-relation-row'});
				const relPill = row.createEl('span', {cls: 'excerpt-badge', text: rel.type});
				relPill.style.backgroundColor = color;
				row.createEl('span', {cls: 'excerpt-claim-relation-arrow', text: '→'});

				const claimChip = row.createEl('span', {cls: 'excerpt-claim-name-chip'});
				if (claimLabel) {
					const truncated = claimLabel.length > 28 ? claimLabel.slice(0, 28) + '…' : claimLabel;
					claimChip.setText(truncated);
					claimChip.title = claimLabel;
				} else {
					claimChip.setText(rel.target.split('/').pop() ?? rel.target);
				}
				claimChip.addEventListener('click', (e) => {
					e.stopPropagation();
					void this.app.workspace.openLinkText(
						`${this.plugin.settings.claimFolder}/${claimId}`, '', false
					);
				});
			});
		}

		if (this.plugin.settings.rslSyncEnabled) {
			const synced = excerpt.rslSelectorId !== undefined;
			body.createEl('span', {
				cls: 'excerpt-rsl-badge' + (synced ? ' excerpt-rsl-badge-synced' : ' excerpt-rsl-badge-local'),
				text: synced ? 'RSL' : 'Local',
				title: synced ? `Synced to RSL (selector #${excerpt.rslSelectorId})` : 'Not synced to RSL',
			});
		}

		const deleteBtn = card.createEl('span', {cls: 'excerpt-delete-btn', text: '×'});
		deleteBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			await this.plugin.store.deleteExcerpt(excerpt.id);
			this.renderExcerptsTab(this.tabContents['excerpts']);
		});

		const actions = body.createDiv({cls: 'excerpt-card-actions'});

		const editBtn = actions.createEl('span', {cls: 'excerpt-action-link', text: 'Edit'});
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new EditExcerptModal(this.plugin, excerpt.id, () => this.renderActiveTab()).open();
		});

		const linkBtn = actions.createEl('span', {cls: 'excerpt-action-link', text: 'Add to claim'});
		linkBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new LinkToClaimModal(this.plugin, excerpt, () => this.renderActiveTab()).open();
		});

		const backLink = actions.createEl('span', {cls: 'excerpt-action-link', text: 'Back to source'});
		backLink.addEventListener('click', async (e) => {
			e.stopPropagation();
			const paperFile = this.app.vault.getAbstractFileByPath(excerpt.source + '.md')
				?? this.app.vault.getAbstractFileByPath(excerpt.source);
			if (paperFile instanceof TFile) {
				const paper = this.plugin.paperStore.readPaper(paperFile);
				if (paper?.pdfPath) {
					await this.plugin.pdfNavigator.navigateToSource(paper.pdfPath, excerpt.page, excerpt.selectionRange);
					return;
				}
			}
			await this.app.workspace.openLinkText(excerpt.source, '', false);
		});

		const copyBtn = actions.createEl('span', {cls: 'excerpt-action-link excerpt-action-copy', text: 'Copy citation'});
		copyBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			await navigator.clipboard.writeText(this.formatExcerptForInsert(excerpt));
			this.flashCopied(copyBtn, 'Copy citation');
		});

		// Pin for comparison (U5)
		const isPinned = this.comparedExcerptIds.has(excerpt.id);
		const pinBtn = actions.createEl('span', {
			cls: 'excerpt-action-link' + (isPinned ? ' excerpt-action-pin-active' : ''),
			text: isPinned ? 'Unpin' : 'Pin',
			title: 'Pin to comparison panel',
		});
		pinBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.comparedExcerptIds.has(excerpt.id)) {
				this.comparedExcerptIds.delete(excerpt.id);
				pinBtn.textContent = 'Pin';
				pinBtn.removeClass('excerpt-action-pin-active');
			} else {
				this.comparedExcerptIds.add(excerpt.id);
				pinBtn.textContent = 'Unpin';
				pinBtn.addClass('excerpt-action-pin-active');
			}
			this.updateCompareTabLabel();
		});

		let hoverTimer: ReturnType<typeof setTimeout> | null = null;
		card.addEventListener('mouseenter', (e) => {
			const linktext = this.getExcerptPdfLinktext(excerpt);
			const {clientX, clientY} = e;
			hoverTimer = setTimeout(() => {
				this.app.workspace.trigger('hover-link', {
					event: new MouseEvent('mouseover', {clientX, clientY, bubbles: true}),
					source: 'excerpt-manager',
					hoverParent: this,
					targetEl: card,
					linktext,
					sourcePath: '',
				});
			}, 1200);
		});
		card.addEventListener('mouseleave', () => {
			if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
		});

		body.addEventListener('click', () => {
			void this.app.workspace.openLinkText(
				`${this.plugin.settings.excerptFolder}/${excerpt.id}`, '', false
			);
		});

		return card;
	}

	// --- Compare tab (U5) ---

	private renderCompareTab(container: HTMLElement): void {
		container.empty();

		const headerRow = container.createDiv({cls: 'excerpt-compare-header'});
		const count = this.comparedExcerptIds.size;
		headerRow.createEl('span', {
			cls: 'excerpt-compare-count',
			text: count === 0
				? 'No excerpts pinned'
				: `${count} excerpt${count > 1 ? 's' : ''} pinned for comparison`,
		});

		if (count > 0) {
			const clearBtn = headerRow.createEl('button', {text: 'Clear all', cls: 'excerpt-compare-clear-btn'});
			clearBtn.addEventListener('click', () => {
				this.comparedExcerptIds.clear();
				this.updateCompareTabLabel();
				this.renderCompareTab(container);
			});
		}

		if (count === 0) {
			container.createEl('p', {
				text: 'Use the "Pin" action on any excerpt card to add it here. Pinned excerpts appear side by side so you can read and compare their full text.',
				cls: 'excerpt-empty-state',
			});
			return;
		}

		const grid = container.createDiv({cls: 'excerpt-compare-grid'});
		const allExcerpts = this.plugin.store.listExcerpts();
		const claimMap = new Map(this.plugin.claimStore.listClaims().map(c => [c.id, c.label]));
		const compared = allExcerpts.filter(e => this.comparedExcerptIds.has(e.id));

		compared.forEach(excerpt => {
			const card = grid.createDiv({cls: 'excerpt-compare-card'});

			const cardHeader = card.createDiv({cls: 'excerpt-compare-card-header'});
			cardHeader.createEl('div', {cls: 'excerpt-compare-card-label', text: excerpt.label});
			const sourceName = excerpt.source.split('/').pop() ?? excerpt.source;
			cardHeader.createEl('div', {
				cls: 'excerpt-compare-card-source',
				text: excerpt.page > 0 ? `${sourceName}  ·  p. ${excerpt.page}` : sourceName,
			});

			if (excerpt.imagePath) {
				const imgFile = this.app.vault.getAbstractFileByPath(excerpt.imagePath);
				if (imgFile instanceof TFile) {
					const img = card.createEl('img', {cls: 'excerpt-compare-card-image'});
					img.src = this.app.vault.getResourcePath(imgFile);
				}
			} else if (excerpt.selectionText) {
				card.createEl('div', {cls: 'excerpt-compare-card-text', text: excerpt.selectionText});
			}

			if (excerpt.relations.length > 0) {
				const relSection = card.createDiv({cls: 'excerpt-compare-card-relations'});
				excerpt.relations.forEach(rel => {
					const claimId = rel.target.split('/').pop() ?? '';
					const claimLabel = claimMap.get(claimId) ?? claimId;
					const color = this.plugin.settings.relationTypes
						.find(rt => rt.name === rel.type)?.color ?? '#888';
					const row = relSection.createDiv({cls: 'excerpt-compare-relation-row'});
					const badge = row.createEl('span', {cls: 'excerpt-badge', text: rel.type});
					badge.style.backgroundColor = color;
					row.createEl('span', {cls: 'excerpt-compare-relation-target', text: ' → ' + claimLabel});
				});
			}

			const cardActions = card.createDiv({cls: 'excerpt-compare-card-actions'});

			const backBtn = cardActions.createEl('span', {cls: 'excerpt-action-link', text: 'Back to source'});
			backBtn.addEventListener('click', async () => {
				const paperFile = this.app.vault.getAbstractFileByPath(excerpt.source + '.md')
					?? this.app.vault.getAbstractFileByPath(excerpt.source);
				if (paperFile instanceof TFile) {
					const paper = this.plugin.paperStore.readPaper(paperFile);
					if (paper?.pdfPath) {
						await this.plugin.pdfNavigator.navigateToSource(paper.pdfPath, excerpt.page, excerpt.selectionRange);
						return;
					}
				}
				await this.app.workspace.openLinkText(excerpt.source, '', false);
			});

			const unpinBtn = cardActions.createEl('span', {cls: 'excerpt-action-link excerpt-action-pin-active', text: 'Unpin'});
			unpinBtn.addEventListener('click', () => {
				this.comparedExcerptIds.delete(excerpt.id);
				this.updateCompareTabLabel();
				this.renderCompareTab(container);
			});
		});
	}

	private updateCompareTabLabel(): void {
		const btn = this.tabButtons['compare'];
		if (!btn) return;
		const count = this.comparedExcerptIds.size;
		btn.textContent = count > 0 ? `Compare (${count})` : 'Compare';
	}

	// --- RSL tab ---

	private async renderRslTab(container: HTMLElement): Promise<void> {
		container.empty();

		if (!this.plugin.settings.rslSyncEnabled) {
			const msg = container.createDiv({cls: 'excerpt-rsl-tab-msg'});
			msg.createEl('p', {text: '☁ RSL sync is disabled.', cls: 'excerpt-empty-state'});
			msg.createEl('p', {text: 'Enable it in Settings → Excerpt Manager → RSL Cloud Sync.', cls: 'excerpt-empty-state'});
			return;
		}

		const headerRow = container.createDiv({cls: 'excerpt-rsl-header-row'});
		headerRow.createEl('span', {cls: 'excerpt-rsl-header-title', text: 'RSL Server Contents'});
		const btnRow = headerRow.createDiv({cls: 'excerpt-rsl-btn-row'});
		const pushAllBtn = btnRow.createEl('button', {cls: 'excerpt-rsl-push-all-btn', text: 'Push All'});
		const pullAllBtn = btnRow.createEl('button', {cls: 'excerpt-rsl-pull-all-btn', text: 'Pull All'});
		const fixTextBtn = btnRow.createEl('button', {cls: 'excerpt-rsl-push-all-btn', text: 'Fix Text'});

		const statusEl = container.createEl('p', {cls: 'excerpt-rsl-status', text: 'Loading…'});
		const listEl   = container.createDiv({cls: 'excerpt-rsl-list'});

		const refresh = () => void this.renderRslTab(container);

		fixTextBtn.addEventListener('click', async () => {
			fixTextBtn.disabled = true; fixTextBtn.textContent = 'Fixing…';
			try {
				const fixed = await this.plugin.rslSync.repairExcerptTexts();
				new Notice(`RSL: Updated text for ${fixed} excerpt(s)`);
				refresh();
			} catch (e) {
				new Notice(`Fix text failed: ${String(e)}`);
			} finally {
				fixTextBtn.disabled = false; fixTextBtn.textContent = 'Fix Text';
			}
		});

		pushAllBtn.addEventListener('click', async () => {
			pushAllBtn.disabled = true; pushAllBtn.textContent = 'Pushing…';
			try {
				this.plugin.rslSync.api.baseUrl = this.plugin.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
				const counts = await this.plugin.rslSync.pushAll();
				new Notice(`RSL: Pushed — ${counts.papers} papers, ${counts.claims} claims, ${counts.excerpts} excerpts, ${counts.links} links${counts.failed ? ` (${counts.failed} failed — see console)` : ''}`);
				refresh();
			} catch (e) {
				new Notice(`RSL push failed: ${String(e)}`);
				pushAllBtn.disabled = false; pushAllBtn.textContent = 'Push All';
			}
		});

		pullAllBtn.addEventListener('click', async () => {
			pullAllBtn.disabled = true; pullAllBtn.textContent = 'Pulling…';
			try {
				this.plugin.rslSync.api.baseUrl = this.plugin.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
				const counts = await this.plugin.rslSync.pullAll();
				new Notice(`RSL: Pulled — ${counts.papers} papers, ${counts.claims} claims, ${counts.excerpts} excerpts, ${counts.links} links${counts.failed ? ` (${counts.failed} failed — see console)` : ''}`);
				refresh();
			} catch (e) {
				new Notice(`RSL pull failed: ${String(e)}`);
				pullAllBtn.disabled = false; pullAllBtn.textContent = 'Pull All';
			}
		});

		try {
			this.plugin.rslSync.api.baseUrl = this.plugin.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');

			const [resources, selectors] = await Promise.all([
				this.plugin.rslSync.api.fetchResources(),
				this.plugin.rslSync.api.fetchSelectors(),
			]);

			if (resources.length === 0) {
				statusEl.setText('No resources found on the RSL server.');
				return;
			}

			statusEl.setText(`${resources.length} resource(s) · ${selectors.length} selector(s) on server`);

			const selectorsByResource = new Map<number, typeof selectors>();
			for (const sel of selectors) {
				const group = selectorsByResource.get(sel.referent) ?? [];
				group.push(sel);
				selectorsByResource.set(sel.referent, group);
			}

			const localPapers   = this.plugin.paperStore.listPapers();
			const localExcerpts = this.plugin.store.listExcerpts();

			for (const resource of resources) {
				const isLocal    = localPapers.some(p => p.rslResourceId === resource.id);
				const paperBlock = listEl.createDiv({cls: 'excerpt-rsl-paper-block'});
				const paperHeader = paperBlock.createDiv({cls: 'excerpt-rsl-paper-header'});

				const statusDot = paperHeader.createEl('span', {
					cls: 'excerpt-rsl-dot ' + (isLocal ? 'excerpt-rsl-dot-local' : 'excerpt-rsl-dot-remote'),
					title: isLocal ? 'Already in vault' : 'Not in vault',
				});
				statusDot.setText(isLocal ? '✓' : '○');

				const paperMeta = paperHeader.createDiv({cls: 'excerpt-rsl-paper-meta'});
				paperMeta.createEl('div', {cls: 'excerpt-rsl-paper-title', text: resource.title});
				const sub = [resource.author, resource.year].filter(Boolean).join(' · ');
				if (sub) paperMeta.createEl('div', {cls: 'excerpt-rsl-paper-sub', text: sub});

				if (!isLocal) {
					const pullBtn = paperHeader.createEl('button', {cls: 'excerpt-rsl-pull-btn', text: 'Pull'});
					pullBtn.addEventListener('click', async () => {
						pullBtn.disabled = true; pullBtn.textContent = '…';
						try {
							await this.plugin.rslSync['ensureLocalPaper'](resource.id, resource.raw);
							new Notice(`Pulled: ${resource.title}`);
							refresh();
						} catch (e) {
							new Notice(`Pull failed: ${String(e)}`);
							pullBtn.disabled = false; pullBtn.textContent = 'Pull';
						}
					});
				}

				const resourceSelectors = selectorsByResource.get(resource.id) ?? [];
				if (resourceSelectors.length === 0) {
					paperBlock.createEl('div', {cls: 'excerpt-rsl-no-excerpts', text: 'No excerpts on server'});
				} else {
					const selList = paperBlock.createDiv({cls: 'excerpt-rsl-selector-list'});
					for (const sel of resourceSelectors) {
						const isExLocal = localExcerpts.some(e => e.rslSelectorId === sel.id);
						const localEx   = localExcerpts.find(e => e.rslSelectorId === sel.id);

						const row = selList.createDiv({cls: 'excerpt-rsl-selector-row'});
						const selDot = row.createEl('span', {
							cls: 'excerpt-rsl-dot ' + (isExLocal ? 'excerpt-rsl-dot-local' : 'excerpt-rsl-dot-remote'),
						});
						selDot.setText(isExLocal ? '✓' : '○');

						row.createEl('span', {
							cls: 'excerpt-rsl-selector-label',
							text: localEx ? localEx.label : `Excerpt · p. ${sel.page}`,
						});
						row.createEl('span', {cls: 'excerpt-rsl-selector-page', text: `p. ${sel.page}`});

						if (!isExLocal) {
							const pullExBtn = row.createEl('button', {cls: 'excerpt-rsl-pull-btn', text: 'Pull'});
							pullExBtn.title = 'Pull this excerpt';
							pullExBtn.addEventListener('click', async () => {
								pullExBtn.disabled = true; pullExBtn.textContent = '…';
								try {
									await this.plugin.rslSync['ensureLocalExcerpt'](sel.raw, resource.id);
									new Notice(`Pulled excerpt (p. ${sel.page})`);
									refresh();
								} catch (e) {
									new Notice(`Pull failed: ${String(e)}`);
									pullExBtn.disabled = false; pullExBtn.textContent = 'Pull';
								}
							});
						}
					}
				}
			}
		} catch (e) {
			statusEl.setText(`Failed to load RSL data: ${String(e)}`);
		}
	}

	// --- Graph tab ---

	private renderGraphTab(container: HTMLElement): void {
		container.empty();
		if (this.graphView) this.graphView.destroy();
		this.graphView = new GraphView(container, this.plugin);
		this.graphView.render();
	}

	// --- Tab / filter switching ---

	private setTab(tab: Tab): void {
		if (this.activeTab === tab) return;
		this.tabContents[this.activeTab].style.display = 'none';
		this.tabButtons[this.activeTab].removeClass('active');
		this.activeTab = tab;
		this.tabContents[tab].style.display = '';
		this.tabButtons[tab].addClass('active');
		this.filterRow.style.display = tab === 'excerpts' ? '' : 'none';
		this.renderActiveTab();
	}

	private setFilter(filter: Filter): void {
		if (this.activeFilter === filter) return;
		this.filterButtons[this.activeFilter].removeClass('active');
		this.activeFilter = filter;
		this.filterButtons[filter].addClass('active');
		if (this.activeTab === 'excerpts') this.renderExcerptsTab(this.tabContents['excerpts']);
		if (this.activeTab === 'claims')   this.renderClaimsTab(this.tabContents['claims']);
	}
}
