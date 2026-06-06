import * as d3 from 'd3';

import {Notice, TFile} from 'obsidian';

import ExcerptManagerPlugin from '../main';

import {GraphData, GraphDataBuilder, ExcerptNode, ClaimNode} from './GraphDataBuilder';

import {Relation} from '../core/types';

import {ensureRelationType} from '../core/relationUtils';

interface TreeNode {

	type: 'root' | 'paper' | 'claim' | 'excerpt' | 'uncategorized';

	id: string;

	label: string;

	sub?: string;

	preview?: string;

	pdfLink?: string;

	pdfPath?: string;

	imagePath?: string;

	isVirtual?: boolean;

	excerptCount?: number;  // claim nodes only: total excerpts (shown when collapsed)

	isCollapsed?: boolean;  // claim nodes only

}

interface NodeLayout {

	x: number;

	y: number;

	h: number;

}

// ── Layout constants (column view) ───────────────────────────────────────────

const PAPER_W    = 240;

const PAPER_H    = 120;

const CLAIM_W    = 190;

const CLAIM_H    = 76;

const EXCERPT_W  = 270;

const V_GAP      = 10;   // vertical gap between sibling nodes

const PAPER_GAP  = 55;   // extra gap between paper groups

// ── Orbit view compact node sizes ────────────────────────────────────────────

const O_PAPER_W   = 240;

const O_PAPER_H   = 120;

const O_CLAIM_W   = 190;

const O_CLAIM_H   = 76;

const O_EXCERPT_W = 200;

const O_EXCERPT_H = 80;

// Radii between node centres in orbit view

const O_R1 = 220;   // paper  → excerpt

const O_R2 = 205;   // excerpt → claim

// Column centre X values

const COL_X = {

	paper:   140,   // paper occupies  20 → 260

	excerpt: 435,   // excerpt occupies 300 → 570

	claim:   760,   // claim occupies 665 → 855

};

export class GraphRenderer {

	private container: HTMLElement;

	private plugin: ExcerptManagerPlugin;

	private data: GraphData;

	private svg: SVGSVGElement | null = null;

	private svgEl: SVGSVGElement | null = null;

	private resizeObserver: ResizeObserver | null = null;

	private lastContainerW = 0;

	// Filter state

	private selectedPaperId:   string | null = null;

	private selectedClaimId:   string | null = null;

	private selectedExcerptId: string | null = null;

	private visibleRelationTypes: Set<string>;

	private showClaims   = true;

	private showExcerpts = true;

	private collapsedClaims: Set<string> = new Set();

	private layoutMode: 'columns' | 'orbit' = 'columns';

	private colSpacing = 1.0;

	private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Link-creation state

	private linkSource: {id: string; type: 'excerpt' | 'claim'; label: string} | null = null;

	private linkOverlay: HTMLElement | null = null;

	private contextMenu: HTMLElement | null = null;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any

	private hoverParent: {hoverPopover: any} = {hoverPopover: null};

	private hoverTimer: ReturnType<typeof setTimeout> | null = null;

	private isDragging = false;

	constructor(container: HTMLElement, plugin: ExcerptManagerPlugin, data: GraphData) {

		this.container = container;

		this.plugin    = plugin;

		this.data      = data;

		this.visibleRelationTypes = new Set(plugin.settings.relationTypes.map(r => r.name));

	}

	render(): void {

		this.container.empty();

		this.container.addClass('excerpt-graph-container');

		this.renderToolbar();

		this.renderSvg();

		this.attachResizeObserver();

	}

	destroy(): void {

		this.endLinkMode();

		this.dismissContextMenu();

		if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = null; }

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access

		this.hoverParent.hoverPopover?.hide?.();

		if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }

	}

	private attachResizeObserver(): void {

		if (this.resizeObserver) this.resizeObserver.disconnect();

		this.lastContainerW = this.container.clientWidth;

		this.resizeObserver = new ResizeObserver(() => {

			const w = this.container.clientWidth;

			if (Math.abs(w - this.lastContainerW) > 4) {

				this.lastContainerW = w;

				this.scheduleRerender();

			}

		});

		this.resizeObserver.observe(this.container);

	}

	// ─── Hover preview ────────────────────────────────────────────────────────

	private triggerHoverLink(e: MouseEvent, linktext: string): void {

		this.plugin.app.workspace.trigger('hover-link', {

			event: e,

			source: 'excerpt-manager',

			hoverParent: this.hoverParent,

			targetEl: e.currentTarget as HTMLElement | null,

			linktext,

			sourcePath: '',

		});

	}

	private hideTooltip(): void {

		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access

		this.hoverParent.hoverPopover?.hide?.();

	}

	// ─── Toolbar ──────────────────────────────────────────────────────────────

	private renderToolbar(): void {

		const bar = this.container.createDiv({cls: 'excerpt-graph-toolbar'});

		// Row 1: Filters

		const row1 = bar.createDiv({cls: 'excerpt-graph-toolbar-row'});

		// Paper filter

		const paperGroup = row1.createDiv({cls: 'excerpt-graph-toolbar-group'});

		paperGroup.createEl('span', {text: 'Paper', cls: 'excerpt-graph-toolbar-label'});

		const paperSel = paperGroup.createEl('select', {cls: 'excerpt-graph-toolbar-select'}) as HTMLSelectElement;

		paperSel.createEl('option', {value: '', text: 'All'});

		this.data.papers.forEach(p => paperSel.createEl('option', {value: p.id, text: p.title || p.id}));

		paperSel.value = this.selectedPaperId ?? '';

		paperSel.addEventListener('change', () => { this.selectedPaperId = paperSel.value || null; this.scheduleRerender(); });

		row1.createDiv({cls: 'excerpt-graph-toolbar-divider'});

		// Claim filter

		const claimGroup = row1.createDiv({cls: 'excerpt-graph-toolbar-group'});

		claimGroup.createEl('span', {text: 'Claim', cls: 'excerpt-graph-toolbar-label'});

		const claimSel = claimGroup.createEl('select', {cls: 'excerpt-graph-toolbar-select'}) as HTMLSelectElement;

		claimSel.createEl('option', {value: '', text: 'All'});

		const allClaims = [

			...this.data.papers.flatMap(p => p.claims),

			...this.data.orphanClaims,

		];

		allClaims.forEach(c => claimSel.createEl('option', {value: c.id, text: c.label}));

		claimSel.value = this.selectedClaimId ?? '';

		claimSel.addEventListener('change', () => { this.selectedClaimId = claimSel.value || null; this.scheduleRerender(); });

		row1.createDiv({cls: 'excerpt-graph-toolbar-divider'});

		// Excerpt filter

		const excerptGroup = row1.createDiv({cls: 'excerpt-graph-toolbar-group'});

		excerptGroup.createEl('span', {text: 'Excerpt', cls: 'excerpt-graph-toolbar-label'});

		const excerptSel = excerptGroup.createEl('select', {cls: 'excerpt-graph-toolbar-select'}) as HTMLSelectElement;

		excerptSel.createEl('option', {value: '', text: 'All'});

		const seenEx = new Set<string>();

		this.data.papers.forEach(p => {

			[...p.claims.flatMap(c => c.excerpts), ...p.unlinkedExcerpts].forEach(ex => {

				if (seenEx.has(ex.id)) return;

				seenEx.add(ex.id);

				excerptSel.createEl('option', {value: ex.id, text: ex.label});

			});

		});

		excerptSel.value = this.selectedExcerptId ?? '';

		excerptSel.addEventListener('change', () => { this.selectedExcerptId = excerptSel.value || null; this.scheduleRerender(); });

		row1.createDiv({cls: 'excerpt-graph-toolbar-spacer'});

		// Layout mode toggle

		row1.createDiv({cls: 'excerpt-graph-toolbar-divider'});

		const layoutGroup = row1.createDiv({cls: 'excerpt-graph-toolbar-group'});

		layoutGroup.createEl('span', {text: 'Layout', cls: 'excerpt-graph-toolbar-label'});

		const colsBtn  = this.pill(layoutGroup, 'Columns', this.layoutMode === 'columns');

		const orbitBtn = this.pill(layoutGroup, 'Orbit',   this.layoutMode === 'orbit');

		colsBtn.addEventListener('click',  () => { this.layoutMode = 'columns'; this.render(); });

		orbitBtn.addEventListener('click', () => { this.layoutMode = 'orbit';   this.render(); });

		// Collapse / Expand all claims

		row1.createDiv({cls: 'excerpt-graph-toolbar-divider'});

		const collapseAllBtn = row1.createEl('button', {cls: 'excerpt-graph-pill-toggle', text: 'Collapse all'});

		collapseAllBtn.addEventListener('click', () => {

			const allClaims = [

				...this.data.papers.flatMap(p => p.claims),

				...this.data.orphanClaims,

			];

			allClaims.forEach(c => this.collapsedClaims.add(c.id));

			this.renderSvg();

		});

		const expandAllBtn = row1.createEl('button', {cls: 'excerpt-graph-pill-toggle', text: 'Expand all'});

		expandAllBtn.addEventListener('click', () => {

			this.collapsedClaims.clear();

			this.renderSvg();

		});

		// Row 2: Show/hide + orbit centre + relation type filters

		const row2 = bar.createDiv({cls: 'excerpt-graph-toolbar-row'});

		const showGroup = row2.createDiv({cls: 'excerpt-graph-toolbar-group'});

		showGroup.createEl('span', {text: 'Show', cls: 'excerpt-graph-toolbar-label'});

		const claimPill = this.pill(showGroup, 'Claims', this.showClaims);

		claimPill.addEventListener('click', () => {

			this.showClaims = !this.showClaims;

			claimPill.classList.toggle('active', this.showClaims);

			this.scheduleRerender();

		});

		const excerptPill = this.pill(showGroup, 'Excerpts', this.showExcerpts);

		excerptPill.addEventListener('click', () => {

			this.showExcerpts = !this.showExcerpts;

			excerptPill.classList.toggle('active', this.showExcerpts);

			this.scheduleRerender();

		});

		if (this.plugin.settings.relationTypes.length > 0) {

			row2.createDiv({cls: 'excerpt-graph-toolbar-divider'});

			const relGroup = row2.createDiv({cls: 'excerpt-graph-toolbar-group'});

			relGroup.createEl('span', {text: 'Relations', cls: 'excerpt-graph-toolbar-label'});

			this.plugin.settings.relationTypes.forEach(rt => {

				const active = this.visibleRelationTypes.has(rt.name);

				const p = relGroup.createEl('button', {cls: 'excerpt-graph-rel-pill' + (active ? ' active' : '')});

				const dot = p.createEl('span', {cls: 'excerpt-graph-rel-dot'});

				dot.style.background = rt.color;

				p.createEl('span', {text: rt.name});

				p.style.color = rt.color;

				p.addEventListener('click', () => {

					if (this.visibleRelationTypes.has(rt.name)) this.visibleRelationTypes.delete(rt.name);

					else this.visibleRelationTypes.add(rt.name);

					p.classList.toggle('active', this.visibleRelationTypes.has(rt.name));

					this.scheduleRerender();

				});

			});

		}

		// Row 3: Column spacing slider
		const row3 = bar.createDiv({cls: 'excerpt-graph-toolbar-row'});
		const spacingGroup = row3.createDiv({cls: 'excerpt-graph-toolbar-group'});
		spacingGroup.createEl('span', {text: 'Spacing', cls: 'excerpt-graph-toolbar-label'});
		const spacingVal = spacingGroup.createEl('span', {text: String(this.colSpacing.toFixed(1)), cls: 'excerpt-graph-toolbar-label'});
		const spacingSlider = spacingGroup.createEl('input') as HTMLInputElement;
		spacingSlider.type = 'range';
		spacingSlider.min  = '0.4';
		spacingSlider.max  = '2.5';
		spacingSlider.step = '0.05';
		spacingSlider.value = String(this.colSpacing);
		spacingSlider.className = 'excerpt-graph-spacing-slider';
		spacingSlider.addEventListener('input', () => {
			this.colSpacing = parseFloat(spacingSlider.value);
			spacingVal.textContent = this.colSpacing.toFixed(1);
			this.scheduleRerender();
		});

	}

	private pill(parent: HTMLElement, label: string, active: boolean): HTMLElement {

		return parent.createEl('button', {cls: 'excerpt-graph-pill-toggle' + (active ? ' active' : ''), text: label});

	}

	// ─── Rerender scheduling ──────────────────────────────────────────────────

	private scheduleRerender(): void {

		if (this.filterDebounceTimer) clearTimeout(this.filterDebounceTimer);

		this.filterDebounceTimer = setTimeout(() => requestAnimationFrame(() => this.renderSvg()), 200);

	}

	// ─── SVG Render ───────────────────────────────────────────────────────────

	private renderSvg(): void {

		if (this.svg) { this.svg.remove(); this.svg = null; }

		this.dismissContextMenu();

		this.endLinkMode();

		const filteredData = this.applyFilters(this.data);

		const nodeLayout = this.layoutMode === 'orbit'

			? this.computeOrbitLayout(filteredData)

			: this.computeAutoLayout(filteredData);

		if (nodeLayout.size === 0) {

			const el = this.container.createEl('p', {

				text: 'No data to display. Create papers and excerpts first.',

				cls: 'excerpt-empty-state',

			});

			el.style.marginTop = '40px';

			return;

		}

		const containerW = this.container.clientWidth  || 700;

		const containerH = Math.max(500, (this.container.clientHeight || 600) - 60);

		const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

		svgEl.setAttribute('width',  String(containerW));

		svgEl.setAttribute('height', String(containerH));

		svgEl.style.display = 'block';

		this.container.appendChild(svgEl);

		this.svg   = svgEl;

		this.svgEl = svgEl;

		const root = d3.select(svgEl);

		// Defs

		const defs = root.append('defs');

		defs.append('filter')

			.attr('id', 'em-shadow')

			.attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%')

			.html('<feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.12"/>');

		// Zoom/pan

		const g = root.append('g');

		const zoom = d3.zoom<SVGSVGElement, unknown>()

			.scaleExtent([0.08, 4])

			.on('zoom', (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => g.attr('transform', String(e.transform)));

		root.call(zoom);

		// Fit content into the container on first render

		const allLayouts  = Array.from(nodeLayout.values());

		const minY        = Math.min(...allLayouts.map(l => l.y - l.h / 2));

		const maxY        = Math.max(...allLayouts.map(l => l.y + l.h / 2));

		const contentW    = COL_X.excerpt + EXCERPT_W / 2 + 40;

		const contentH    = maxY - minY + 80;

		const scale       = Math.max(0.2, Math.min(1, (containerW - 40) / contentW, (containerH - 40) / contentH));

		const tx          = (containerW - contentW  * scale) / 2;

		const ty          = 20 - minY * scale;

		g.attr('transform', `translate(${tx},${ty}) scale(${scale})`);

		root.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

		// Edges (always drawn behind nodes)

		const edgeGroup = g.append('g').attr('class', 'em-edge-group');

		if (this.layoutMode === 'orbit') {

			this.drawOrbitEdges(edgeGroup, filteredData, nodeLayout);

		} else {

			this.drawHierarchyEdges(edgeGroup, filteredData, nodeLayout);

		}

		this.drawRelationEdges(edgeGroup, filteredData, nodeLayout);

		// Nodes

		const flatNodes  = this.buildFlatNodeList(filteredData);

		const nodeGroups = g.selectAll<SVGGElement, TreeNode>('g.em-node')

			.data(flatNodes)

			.enter().append('g')

			.attr('class', 'em-node')

			.attr('data-node-id',    d => d.id)

			.attr('data-node-type',  d => d.type)

			.attr('data-node-label', d => d.label)

			.attr('transform', d => { const p = nodeLayout.get(d.id)!; return `translate(${p.x},${p.y})`; })

			.style('cursor', 'pointer');

		// Orbit mode: draw cluster background bubbles behind nodes

		if (this.layoutMode === 'orbit') {

			this.drawOrbitClusters(g, filteredData, nodeLayout);

		}

		nodeGroups.each((d, i, els) => {

			const el = els[i];

			if (!el) return;

			const group = d3.select<SVGGElement, TreeNode>(el);

			if (this.layoutMode === 'orbit') {

				switch (d.type) {

					case 'paper':   this.drawOrbitPaperNode  (group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

					case 'claim':   this.drawOrbitClaimNode  (group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

					case 'excerpt': this.drawOrbitExcerptNode(group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

				}

			} else {

				switch (d.type) {

					case 'paper':   this.drawPaperNode  (group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

					case 'claim':   this.drawClaimNode  (group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

					case 'excerpt': this.drawExcerptNode(group as unknown as d3.Selection<SVGGElement, unknown, null, unknown>, d); break;

				}

			}

		});

		// Click handlers

		const {excerptFolder, claimFolder} = this.plugin.settings;

		nodeGroups.on('click', (e: MouseEvent, d) => {

			if (this.linkSource) { this.handleLinkTarget(d); return; }

			// Toggle collapse/expand for claim nodes

			if (d.type === 'claim' && (e.target as SVGElement).getAttribute('data-action') === 'toggle-claim') {

				if (this.collapsedClaims.has(d.id)) this.collapsedClaims.delete(d.id);

				else this.collapsedClaims.add(d.id);

				this.renderSvg();

				return;

			}

			if (d.type === 'claim')   void this.plugin.app.workspace.openLinkText(`${claimFolder}/${d.id}`,   '', false);

			if (d.type === 'excerpt') void this.plugin.app.workspace.openLinkText(`${excerptFolder}/${d.id}`, '', false);

			if (d.type === 'paper') {

				if (d.isVirtual && d.pdfPath) void this.plugin.app.workspace.openLinkText(d.pdfPath, '', false);

				else { this.selectedPaperId = this.selectedPaperId === d.id ? null : d.id; this.renderSvg(); }

			}

		}).on('contextmenu', (e: MouseEvent, d) => {

			e.preventDefault();

			if (d.type === 'excerpt' || d.type === 'claim') this.showContextMenu(e, d);

		});

		// Hover: PDF preview popover for excerpts

		nodeGroups.on('mouseover', (e: MouseEvent, d) => {

			if (d.type === 'excerpt' && d.pdfLink && !this.isDragging) {

				const {clientX, clientY} = e;

				const pdfLink = d.pdfLink;

				if (this.hoverTimer) clearTimeout(this.hoverTimer);

				this.hoverTimer = setTimeout(() => {

					if (this.isDragging) return;

					this.triggerHoverLink(new MouseEvent('mouseover', {clientX, clientY, bubbles: true}), pdfLink);

				}, 1200);

			}

			if (d.type === 'excerpt') {
				const svgEl = this.svgEl;
				if (svgEl) {
					svgEl.querySelectorAll<SVGPathElement>('.em-provenance-edge').forEach(el => {
						el.style.opacity = el.dataset.provenanceId === d.id ? '1' : '0.1';
						if (el.dataset.provenanceId === d.id) {
							el.style.strokeWidth = '2.5';
							el.style.stroke = '#ffffff';
						}
					});
				}
			}

		}).on('mouseout', () => {

			if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = null; }

			this.hideTooltip();

			const svgEl2 = this.svgEl;
			if (svgEl2) {
				svgEl2.querySelectorAll<SVGPathElement>('.em-provenance-edge').forEach(el => {
					el.style.opacity = '';
					el.style.strokeWidth = '';
					el.style.stroke = '';
				});
			}
		});

		// ── Connector dots (drag-to-link) ──────────────────────────────────────

		const self = this;

		const toLocal = (clientX: number, clientY: number) => {

			const svgRect = svgEl.getBoundingClientRect();

			const zoomT   = d3.zoomTransform(svgEl);

			return { x: (clientX - svgRect.left - zoomT.x) / zoomT.k, y: (clientY - svgRect.top - zoomT.y) / zoomT.k };

		};

		let dragLine: d3.Selection<SVGLineElement, unknown, null, unknown> | null = null;

		let dragSrc: {id: string; type: string; label: string} | null = null;

		const onLinkMove = (e: MouseEvent) => {

			if (!dragLine) return;

			const local = toLocal(e.clientX, e.clientY);

			dragLine.attr('x2', local.x).attr('y2', local.y);

			svgEl.querySelectorAll<SVGGElement>('g.em-node').forEach(el => {

				const rect = el.getBoundingClientRect();

				const over = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;

				const type = el.getAttribute('data-node-type');

				// Excerpts cannot link directly to papers

				const isValidTarget = type === 'claim' || type === 'excerpt' || (type === 'paper' && dragSrc?.type !== 'excerpt');

				el.style.opacity = (over && isValidTarget) ? '0.7' : '1';

			});

		};

		const onLinkUp = (e: MouseEvent) => {

			document.removeEventListener('mousemove', onLinkMove);

			document.removeEventListener('mouseup',   onLinkUp);

			if (dragLine) { dragLine.remove(); dragLine = null; }

			svgEl.querySelectorAll<SVGGElement>('g.em-node').forEach(el => { el.style.opacity = '1'; });

			const source = dragSrc; dragSrc = null;

			if (!source) return;

			let targetId: string | null = null, targetType: string | null = null, targetLabel: string | null = null;

			for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {

				const nodeEl = el.closest('g.em-node');

				if (nodeEl) {

					targetId    = nodeEl.getAttribute('data-node-id');

					targetType  = nodeEl.getAttribute('data-node-type');

					targetLabel = nodeEl.getAttribute('data-node-label');

					break;

				}

			}

			if (!targetId || !targetType || targetId === source.id) return;

			if (targetType !== 'claim' && targetType !== 'excerpt' && targetType !== 'paper') return;

			// Excerpts cannot link directly to papers; only excerpt → claim → paper

			if (source.type === 'excerpt' && targetType === 'paper') return;

			self.showRelationPicker(source, {id: targetId, type: targetType, label: targetLabel ?? targetId});

		};

		nodeGroups.each(function(d) {

			if (d.type !== 'claim' && d.type !== 'excerpt') return;

			const layout = nodeLayout.get(d.id);

			if (!layout) return;

			const dotCy = layout.h / 2 + 1;

			const dot = d3.select(this).append('circle')

				.attr('class', 'em-connector')

				.attr('cx', 0).attr('cy', dotCy)

				.attr('r', 6)

				.attr('fill', 'var(--interactive-accent)')

				.attr('stroke', 'var(--background-primary)')

				.attr('stroke-width', 1.5)

				.attr('opacity', 0.22)

				.style('cursor', 'crosshair');

			dot.on('mouseenter', function() { d3.select(this).attr('opacity', 0.9).attr('r', 8); })

			   .on('mouseleave', function() { d3.select(this).attr('opacity', 0.22).attr('r', 6); })

			   .on('mousedown', function(event: MouseEvent) {

					event.stopPropagation();

					event.preventDefault();

					const pos = nodeLayout.get(d.id)!;

					dragSrc  = {id: d.id, type: d.type, label: d.label};

					dragLine = g.append('line')

						.attr('x1', pos.x).attr('y1', pos.y + dotCy)

						.attr('x2', pos.x).attr('y2', pos.y + dotCy)

						.attr('stroke', 'var(--interactive-accent)')

						.attr('stroke-width', 2)

						.attr('stroke-dasharray', '6,3')

						.attr('pointer-events', 'none')

						.attr('opacity', 0.8);

					document.addEventListener('mousemove', onLinkMove);

					document.addEventListener('mouseup',   onLinkUp);

				});

		});

		// Load PDF thumbnails asynchronously

		void this.loadThumbnails(flatNodes);

	}

	// ─── Filtering ────────────────────────────────────────────────────────────

	private applyFilters(data: GraphData): GraphData {

		let papers = data.papers;

		let orphanClaims = data.orphanClaims;

		// Filter by paper

		if (this.selectedPaperId) {

			papers = papers.filter(p => p.id === this.selectedPaperId);

		}

		// Filter by claim

		if (this.selectedClaimId) {

			papers = papers

				.filter(p => p.claims.some(c => c.id === this.selectedClaimId))

				.map(p => ({

					...p,

					claims: p.claims.filter(c => c.id === this.selectedClaimId),

					unlinkedExcerpts: [],

				}));

			orphanClaims = orphanClaims.filter(c => c.id === this.selectedClaimId);

		}

		// Filter by excerpt

		if (this.selectedExcerptId) {

			papers = papers

				.filter(p =>

					p.claims.some(c => c.excerpts.some(e => e.id === this.selectedExcerptId)) ||

					p.unlinkedExcerpts.some(e => e.id === this.selectedExcerptId)

				)

				.map(p => ({

					...p,

					claims: p.claims

						.filter(c => c.excerpts.some(e => e.id === this.selectedExcerptId))

						.map(c => ({...c, excerpts: c.excerpts.filter(e => e.id === this.selectedExcerptId)})),

					unlinkedExcerpts: p.unlinkedExcerpts.filter(e => e.id === this.selectedExcerptId),

				}));

			orphanClaims = [];

		}

		return {...data, papers, orphanClaims};

	}

	// ─── Auto-layout ──────────────────────────────────────────────────────────

	private computeAutoLayout(data: GraphData): Map<string, NodeLayout> {

		const pos = new Map<string, NodeLayout>();

		let y = 40;

		for (const paper of data.papers) {

			const seenExcerpts  = new Set<string>();

			const excerptYMap   = new Map<string, number>(); // excerptId → centerY

			if (this.showExcerpts && this.showClaims) {

				// Place excerpts first, grouped by claim (skip collapsed claims)

				for (const claim of paper.claims) {

					if (this.collapsedClaims.has(claim.id)) continue;

					for (const ex of claim.excerpts) {

						if (seenExcerpts.has(ex.id)) continue;

						seenExcerpts.add(ex.id);

						const h = this.getExcerptNodeHeight(ex);

						excerptYMap.set(ex.id, y + h / 2);

						pos.set(ex.id, {x: COL_X.excerpt, y: y + h / 2, h});

						y += h + V_GAP;

					}

				}

				// Unlinked excerpts follow claims' excerpts

				for (const ex of paper.unlinkedExcerpts) {

					if (seenExcerpts.has(ex.id)) continue;

					seenExcerpts.add(ex.id);

					const h = this.getExcerptNodeHeight(ex);

					excerptYMap.set(ex.id, y + h / 2);

					pos.set(ex.id, {x: COL_X.excerpt, y: y + h / 2, h});

					y += h + V_GAP;

				}

				// Place claims centred on their excerpts' Y range

				for (const claim of paper.claims) {

					const claimExYs = claim.excerpts

						.filter(ex => excerptYMap.has(ex.id))

						.map(ex => excerptYMap.get(ex.id)!);

					let claimY: number;

					if (claimExYs.length > 0) {

						claimY = (Math.min(...claimExYs) + Math.max(...claimExYs)) / 2;

					} else {

						claimY = y + CLAIM_H / 2;

						y += CLAIM_H + V_GAP;

					}

					pos.set(claim.id, {x: COL_X.claim, y: claimY, h: CLAIM_H});

				}

			} else if (this.showClaims && !this.showExcerpts) {

				for (const claim of paper.claims) {

					pos.set(claim.id, {x: COL_X.claim, y: y + CLAIM_H / 2, h: CLAIM_H});

					y += CLAIM_H + V_GAP;

				}

			} else if (!this.showClaims && this.showExcerpts) {

				for (const claim of paper.claims) {

					if (this.collapsedClaims.has(claim.id)) continue;

					for (const ex of claim.excerpts) {

						if (seenExcerpts.has(ex.id)) continue;

						seenExcerpts.add(ex.id);

						const h = this.getExcerptNodeHeight(ex);

						excerptYMap.set(ex.id, y + h / 2);

						pos.set(ex.id, {x: COL_X.excerpt, y: y + h / 2, h});

						y += h + V_GAP;

					}

				}

				for (const ex of paper.unlinkedExcerpts) {

					if (seenExcerpts.has(ex.id)) continue;

					seenExcerpts.add(ex.id);

					const h = this.getExcerptNodeHeight(ex);

					excerptYMap.set(ex.id, y + h / 2);

					pos.set(ex.id, {x: COL_X.excerpt, y: y + h / 2, h});

					y += h + V_GAP;

				}

			}

			// Place paper centred on all its content

			const allContentYs: number[] = [

				...Array.from(excerptYMap.values()),

				...paper.claims.filter(c => pos.has(c.id)).map(c => pos.get(c.id)!.y),

			];

			let paperY: number;

			if (allContentYs.length > 0) {

				paperY = (Math.min(...allContentYs) + Math.max(...allContentYs)) / 2;

			} else {

				paperY = y + PAPER_H / 2;

				y += PAPER_H + V_GAP;

			}

			pos.set(paper.id, {x: COL_X.paper, y: paperY, h: PAPER_H});

			y += PAPER_GAP;

		}

		// Orphan claims

		if (this.showClaims) {

			for (const claim of data.orphanClaims) {

				pos.set(claim.id, {x: COL_X.claim, y: y + CLAIM_H / 2, h: CLAIM_H});

				y += CLAIM_H + V_GAP;

			}

		}

		// ── Resolve claim-column overlaps ─────────────────────────────────────

		// When an excerpt is linked to multiple claims, all those claims get the

		// same desired Y (centred on the shared excerpt). Push them apart so every

		// claim node is fully visible.

		if (this.showClaims) {

			const MIN_SPACING = CLAIM_H + V_GAP;

			// Collect all claim-column nodes sorted by current Y

			const claimIds = Array.from(pos.keys())

				.filter(id => pos.get(id)!.x === COL_X.claim)

				.sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);

			// Iteratively push overlapping pairs apart (symmetric, preserves centroid).

			// Converges in O(n) passes for the typical small number of claims.

			for (let pass = 0; pass < 100; pass++) {

				let moved = false;

				for (let i = 0; i < claimIds.length - 1; i++) {

					const idA = claimIds[i], idB = claimIds[i + 1];

					if (!idA || !idB) continue;

					const a  = pos.get(idA)!;

					const b  = pos.get(idB)!;

					const overlap = MIN_SPACING - (b.y - a.y);

					if (overlap > 0.5) {

						pos.set(idA, {...a, y: a.y - overlap / 2});

						pos.set(idB, {...b, y: b.y + overlap / 2});

						moved = true;

					}

				}

				if (!moved) break;

			}

		}

		// ── Resolve excerpt-column overlaps ───────────────────────────────────

		// Claims centred on shared excerpts can produce overlapping excerpt nodes.

		// Push them apart so every excerpt card is fully visible.

		if (this.showExcerpts) {

			const excerptIds = Array.from(pos.keys())

				.filter(id => pos.get(id)!.x === COL_X.excerpt)

				.sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);

			for (let pass = 0; pass < 200; pass++) {

				let moved = false;

				for (let i = 0; i < excerptIds.length - 1; i++) {

					const idA = excerptIds[i], idB = excerptIds[i + 1];

					if (!idA || !idB) continue;

					const a   = pos.get(idA)!;

					const b   = pos.get(idB)!;

					const minSpacing = (a.h + b.h) / 2 + V_GAP;

					const overlap    = minSpacing - (b.y - a.y);

					if (overlap > 0.5) {

						pos.set(idA, {...a, y: a.y - overlap / 2});

						pos.set(idB, {...b, y: b.y + overlap / 2});

						moved = true;

					}

				}

				if (!moved) break;

			}

		}

		// Apply column spacing multiplier: scale excerpt and claim x away from paper anchor
		if (this.colSpacing !== 1.0) {
			const paperAnchor = COL_X.paper;
			pos.forEach((layout) => {
				if (layout.x !== paperAnchor) {
					layout.x = paperAnchor + (layout.x - paperAnchor) * this.colSpacing;
				}
			});
		}

		return pos;

	}

	// ─── Orbit (cluster) layout ────────────────────────────────────────────────────

	//

	// Each paper is a compact hub; claims are small chips orbiting it;

	// excerpts are tiny pills orbiting each claim.

	// Papers are placed on a ring so no two clusters overlap.

	// All positions are deterministic (no simulation).

	private computeOrbitLayout(data: GraphData): Map<string, NodeLayout> {

		const pos = new Map<string, NodeLayout>();

		const N   = data.papers.length;

		// Maximum radius any cluster can reach

		const maxClusterR = O_R1 + O_R2 + O_CLAIM_W / 2 + 10;

		const gridSpacing = 2 * maxClusterR + 20;

		// Grid layout: 1-2-3-4 columns depending on paper count

		const cols = N <= 2 ? Math.max(1, N) : N <= 4 ? 2 : N <= 9 ? 3 : 4;

		const rows = N > 0  ? Math.ceil(N / cols) : 1;

		data.papers.forEach((paper, pi) => {

			const col = pi % cols;

			const row = Math.floor(pi / cols);

			const px  = (col - (cols - 1) / 2) * gridSpacing;

			const py  = (row - (rows - 1) / 2) * gridSpacing;

			pos.set(paper.id, {x: px, y: py, h: O_PAPER_H});

			// Collect all excerpts for this paper (unlinked + claim-linked), deduped
			const allPaperExcerpts: ExcerptNode[] = [];
			const seenEx = new Set<string>();
			if (this.showExcerpts) {
				for (const ex of paper.unlinkedExcerpts) {
					if (!seenEx.has(ex.id)) { seenEx.add(ex.id); allPaperExcerpts.push(ex); }
				}
				for (const claim of paper.claims) {
					if (this.collapsedClaims.has(claim.id)) continue;
					for (const ex of claim.excerpts) {
						if (ex.sourcePaperId !== paper.id) continue;
						if (!seenEx.has(ex.id)) { seenEx.add(ex.id); allPaperExcerpts.push(ex); }
					}
				}
			}
			// Build reverse map: excerptId -> claims linked to it (for R2 orbit)
			const excerptClaims = new Map<string, ClaimNode[]>();
			if (this.showClaims) {
				for (const claim of paper.claims) {
					for (const ex of claim.excerpts) {
						if (!excerptClaims.has(ex.id)) excerptClaims.set(ex.id, []);
						excerptClaims.get(ex.id)!.push(claim);
					}
				}
			}
			const totalSlots = allPaperExcerpts.length;
			if (totalSlots === 0 && (!this.showClaims || paper.claims.length === 0)) return;
			const slotAngle = (s: number) => totalSlots > 0
				? (2 * Math.PI * s) / totalSlots - Math.PI / 2
				: -Math.PI / 2;
			const seenClaim = new Set<string>();
			// Place excerpts at R1 around the paper, fan claims at R2 beyond each excerpt
			allPaperExcerpts.forEach((ex, slot) => {
				const a   = slotAngle(slot);
				const exX = px + O_R1 * Math.cos(a);
				const exY = py + O_R1 * Math.sin(a);
				pos.set(ex.id, {x: exX, y: exY, h: O_EXCERPT_H});
				if (this.showClaims) {
					const linkedClaims = (excerptClaims.get(ex.id) ?? []).filter(c => !seenClaim.has(c.id));
					const C = linkedClaims.length;
					if (C === 0) return;
					const r2 = Math.max(O_R2, Math.min(O_R2 * 2, C * (O_CLAIM_W + 8) / (Math.PI * (4 / 3))));
					const clSpan  = C === 1 ? 0 : Math.min(Math.PI * (4 / 3), C * (Math.PI / 5));
					const clStart = a - clSpan / 2;
					const clStep  = C > 1 ? clSpan / (C - 1) : 0;
					linkedClaims.forEach((claim, j) => {
						seenClaim.add(claim.id);
						const ca = clStart + clStep * j;
						pos.set(claim.id, {x: exX + r2 * Math.cos(ca), y: exY + r2 * Math.sin(ca), h: O_CLAIM_H});
					});
				}
			});
			// Fallback: if no excerpts, place claims directly at R1
			if (this.showClaims && totalSlots === 0) {
				paper.claims.forEach((claim, slot) => {
					if (seenClaim.has(claim.id)) return;
					seenClaim.add(claim.id);
					const a = (2 * Math.PI * slot) / paper.claims.length - Math.PI / 2;
					pos.set(claim.id, {x: px + O_R1 * Math.cos(a), y: py + O_R1 * Math.sin(a), h: O_CLAIM_H});
				});
			}
		});

		// Orphan claims row below the grid

		if (this.showClaims && data.orphanClaims.length > 0) {

			const orphanY = ((rows - 1) / 2) * gridSpacing + maxClusterR + 60;

			const totalW  = (data.orphanClaims.length - 1) * (O_CLAIM_W + 20);

			data.orphanClaims.forEach((claim, i) => {

				pos.set(claim.id, {

					x: -totalW / 2 + i * (O_CLAIM_W + 20),

					y: orphanY,

					h: O_CLAIM_H,

				});

			});

		}

		return pos;

	}

	private getExcerptNodeHeight(ex: ExcerptNode): number {

		const CHARS_PER_LINE = 38;

		const LINE_H         = 13;

		const HEADER_H       = 46;  // title area

		const FOOTER_H       = 22;  // page footer

		const IMG_H          = 100; // image preview (compact)

		if (ex.imagePath) return HEADER_H + IMG_H + FOOTER_H + 12;

		if (!ex.selectionText) return HEADER_H + FOOTER_H + 8;

		const previewText = ex.selectionText.slice(0, 120); // cap preview

		const lines = Math.min(Math.ceil(previewText.length / CHARS_PER_LINE), 3);

		return Math.min(HEADER_H + lines * LINE_H + FOOTER_H + 12, 120);

	}

	// ─── Flat node list (replaces D3 tree) ────────────────────────────────────

	private buildFlatNodeList(data: GraphData): TreeNode[] {

		const nodes: TreeNode[] = [];

		const seenExcerpts = new Set<string>();

		data.papers.forEach(paper => {

			nodes.push({

				type: 'paper',

				id:   paper.id,

				label: paper.title || paper.id,

				sub: paper.authors.length > 0

					? paper.authors.slice(0, 2).join(', ') + (paper.authors.length > 2 ? ' et al.' : '') + (paper.year ? ` · ${paper.year}` : '')

					: (paper.year ? String(paper.year) : undefined),

				pdfPath:   paper.pdfPath,

				isVirtual: paper.isVirtual,

			});

			if (this.showClaims) {

				paper.claims.forEach(claim => {

					const collapsed = this.collapsedClaims.has(claim.id);

					nodes.push({

						type: 'claim',

						id: claim.id,

						label: claim.label,

						excerptCount: claim.excerpts.length,

						isCollapsed: collapsed,

					});

				});

			}

			if (this.showExcerpts) {

				const addExcerpt = (ex: ExcerptNode) => {

					if (seenExcerpts.has(ex.id)) return;

					seenExcerpts.add(ex.id);

					const pdfLink = paper.pdfPath

						? (ex.selectionRange

							? `${paper.pdfPath}#page=${ex.page}&selection=${ex.selectionRange}`

							: `${paper.pdfPath}#page=${ex.page}`)

						: undefined;

					nodes.push({

						type: 'excerpt',

						id:   ex.id,

						label: ex.label,

						sub:   `p. ${ex.page}`,

						preview:   ex.selectionText,

						imagePath: ex.imagePath,

						pdfLink,

					});

				};

				paper.claims.forEach(c => {

					if (this.collapsedClaims.has(c.id)) return; // skip excerpts for collapsed claims

					c.excerpts.forEach(addExcerpt);

				});

				paper.unlinkedExcerpts.forEach(addExcerpt);

			}

		});

		if (this.showClaims) {

			data.orphanClaims.forEach(c => nodes.push({type: 'claim', id: c.id, label: c.label}));

		}

		return nodes;

	}

	// ─── Hierarchy edges ──────────────────────────────────────────────────────

	private drawHierarchyEdges(

		g: d3.Selection<SVGGElement, unknown, null, unknown>,

		data: GraphData,

		pos: Map<string, NodeLayout>

	): void {

		const paperEdgeColor  = 'white';

		const drawPaperToExcerpt = (paperY: number, ep: NodeLayout, excerptId: string) => {

			const exLeft = ep.x - EXCERPT_W / 2;

			const mx     = (paperRight + exLeft) / 2;

			g.append('path')

				.attr('fill', 'none')

				.attr('stroke', paperEdgeColor)

				.attr('stroke-width', 1)

				.attr('stroke-dasharray', '4,3')

				.attr('opacity', 0.45)

				.attr('class', 'em-provenance-edge')

				.attr('data-provenance-id', excerptId)

				.attr('d', `M${paperRight},${paperY} C${mx},${paperY} ${mx},${ep.y} ${exLeft},${ep.y}`);

		};

		// paperRight is needed inside drawPaperToExcerpt — capture via closure per paper

		let paperRight = 0;

		data.papers.forEach(paper => {

			const pp = pos.get(paper.id);

			if (!pp) return;

			paperRight = pp.x + PAPER_W / 2;

			if (this.showClaims) {

				paper.claims.forEach(claim => {

					const cp = pos.get(claim.id);

					if (!cp) return;

					const isCollapsed = this.collapsedClaims.has(claim.id);

					if (this.showExcerpts && !isCollapsed) {

						const seenEx = new Set<string>();

						claim.excerpts.forEach(ex => {

							if (seenEx.has(ex.id)) return;

							seenEx.add(ex.id);

							const ep = pos.get(ex.id);

							if (!ep) return;

							// Paper → Excerpt: only draw from the excerpt's actual source paper

							if (ex.sourcePaperId !== paper.id) return;

							drawPaperToExcerpt(pp.y, ep, ex.id);

						});

					}

				});

			}

			if (this.showExcerpts) {

				// Paper → Unlinked excerpts (dashed accent)

				paper.unlinkedExcerpts.forEach(ex => {

					const ep = pos.get(ex.id);

					if (!ep) return;

					drawPaperToExcerpt(pp.y, ep, ex.id);

				});

				// Paper → Excerpts when claims hidden

				if (!this.showClaims) {

					const seenEx = new Set<string>();

					paper.claims.forEach(c => c.excerpts.forEach(ex => {

						if (seenEx.has(ex.id)) return;

						seenEx.add(ex.id);

						const ep = pos.get(ex.id);

						if (!ep) return;

						drawPaperToExcerpt(pp.y, ep, ex.id);

					}));

				}

			}

		});

	}

	// ─── Orbit edge drawing ───────────────────────────────────────────────────

	private drawOrbitEdges(

		g: d3.Selection<SVGGElement, unknown, null, unknown>,

		data: GraphData,

		pos: Map<string, NodeLayout>

	): void {

		const line = (ax: number, ay: number, bx: number, by: number,

		              color: string, dash: string, opacity: number, width = 1) => {

			// Slight bow perpendicular to the edge direction, for visual clarity

			const dx = bx - ax, dy = by - ay;

			const len = Math.sqrt(dx * dx + dy * dy) || 1;

			const bow = Math.min(len * 0.12, 30);

			const qx  = (ax + bx) / 2 - (dy / len) * bow;

			const qy  = (ay + by) / 2 + (dx / len) * bow;

			g.append('path')

				.attr('fill', 'none')

				.attr('stroke', color).attr('stroke-width', width)

				.attr('stroke-dasharray', dash).attr('opacity', opacity)

				.attr('d', `M${ax},${ay} Q${qx},${qy} ${bx},${by}`);

		};

		const seenEx = new Set<string>();

		data.papers.forEach(paper => {

			const pp = pos.get(paper.id);

			if (!pp) return;

			if (this.showClaims) {

				paper.claims.forEach(claim => {

					const cp = pos.get(claim.id);

					if (!cp) return;

					line(pp.x, pp.y, cp.x, cp.y, 'var(--color-accent)', 'none', 0.55, 1.5);

					if (this.showExcerpts && !this.collapsedClaims.has(claim.id)) {

						claim.excerpts.forEach(ex => {

							const ep = pos.get(ex.id);

							if (!ep) return;

							if (!seenEx.has(ex.id)) {

								seenEx.add(ex.id);

								line(pp.x, pp.y, ep.x, ep.y, 'white', '4,3', 0.35);

							}

							line(cp.x, cp.y, ep.x, ep.y, 'var(--background-modifier-border)', 'none', 0.6);

						});

					}

				});

			}

			if (this.showExcerpts) {

				paper.unlinkedExcerpts.forEach(ex => {

					const ep = pos.get(ex.id);

					if (!ep) return;

					if (!seenEx.has(ex.id)) {

						seenEx.add(ex.id);

						line(pp.x, pp.y, ep.x, ep.y, 'white', '4,3', 0.4);

					}

				});

				if (!this.showClaims) {

					paper.claims.forEach(c => {

						if (this.collapsedClaims.has(c.id)) return;

						c.excerpts.forEach(ex => {

							const ep = pos.get(ex.id);

							if (!ep) return;

							if (!seenEx.has(ex.id)) {

								seenEx.add(ex.id);

								line(pp.x, pp.y, ep.x, ep.y, 'white', '4,3', 0.4);

							}

						});

					});

				}

			}

		});

	}

	// --- Orbit cluster bubbles + compact node drawers

	private drawOrbitClusters(

		g: d3.Selection<SVGGElement, unknown, null, unknown>,

		data: GraphData,

		pos: Map<string, NodeLayout>

	): void {

		data.papers.forEach(paper => {

			const pp = pos.get(paper.id);

			if (!pp) return;

			const clusterIds = [

				...paper.claims.map(c => c.id),

				...paper.unlinkedExcerpts.map(e => e.id),

				...paper.claims.flatMap(c => c.excerpts.map(e => e.id)),

			];

			let maxR = 0;

			clusterIds.forEach(id => {

				const np = pos.get(id);

				if (np) maxR = Math.max(maxR, Math.hypot(np.x - pp.x, np.y - pp.y));

			});

			if (maxR < 10) return;

			const r = maxR + O_EXCERPT_W / 2 + 18;

			g.insert('circle', ':first-child')

				.attr('cx', pp.x).attr('cy', pp.y).attr('r', r)

				.attr('fill', 'var(--background-secondary)')

				.attr('fill-opacity', 0.18)

				.attr('stroke', 'var(--background-modifier-border)')

				.attr('stroke-width', 1)

				.attr('stroke-dasharray', '5,4')

				.attr('stroke-opacity', 0.35);

		});

	}

	private drawOrbitPaperNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {
		const w = O_PAPER_W, h = O_PAPER_H, rx = 8;
		g.append('rect')
			.attr('x', -w / 2).attr('y', -h / 2)
			.attr('width', w).attr('height', h).attr('rx', rx)
			.attr('fill', 'var(--background-secondary)')
			.attr('stroke', n.isVirtual ? 'var(--text-faint)' : 'var(--color-accent)')
			.attr('stroke-width', n.isVirtual ? 1 : 2)
			.attr('filter', 'url(#em-shadow)');
		g.append('text')
			.attr('x', -w / 2 + 10).attr('y', 1)
			.attr('dominant-baseline', 'middle')
			.attr('font-size', 16).attr('fill', 'var(--text-faint)').attr('opacity', 0.45)
			.text('📄');
		const maxCh = Math.floor((w - 36) / 7.5);
		const title = n.label.length > maxCh ? n.label.slice(0, maxCh - 1) + '…' : n.label;
		g.append('text')
			.attr('x', -w / 2 + 32).attr('y', n.sub ? -8 : 1)
			.attr('dominant-baseline', 'middle')
			.attr('font-size', 13).attr('font-weight', '700')
			.attr('fill', 'var(--text-normal)').text(title);
		if (n.sub) {
			const sub = n.sub.length > maxCh ? n.sub.slice(0, maxCh - 1) + '…' : n.sub;
			g.append('text')
				.attr('x', -w / 2 + 32).attr('y', 10)
				.attr('dominant-baseline', 'middle')
				.attr('font-size', 10).attr('fill', 'var(--text-muted)').text(sub);
		}
	}

	private drawOrbitClaimNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {
		const w = O_CLAIM_W, h = O_CLAIM_H, rx = 6;
		g.append('rect')
			.attr('x', -w / 2).attr('y', -h / 2)
			.attr('width', w).attr('height', h).attr('rx', rx)
			.attr('fill', 'var(--background-primary)')
			.attr('stroke', 'var(--color-accent)').attr('stroke-width', 1.5)
			.attr('filter', 'url(#em-shadow)');
		g.append('rect')
			.attr('x', -w / 2).attr('y', -h / 2)
			.attr('width', 4).attr('height', h).attr('rx', rx)
			.attr('fill', 'var(--color-accent)');
		const tbW = 22, tbH = 16;
		const tbX = w / 2 - tbW - 4, tbY = -h / 2 + 4;
		g.append('rect')
			.attr('x', tbX).attr('y', tbY)
			.attr('width', tbW).attr('height', tbH).attr('rx', 4)
			.attr('fill', 'var(--background-modifier-hover)')
			.attr('stroke', 'var(--background-modifier-border)').attr('stroke-width', 0.5)
			.attr('data-action', 'toggle-claim').style('cursor', 'pointer');
		g.append('text')
			.attr('x', tbX + tbW / 2).attr('y', tbY + tbH / 2 + 1)
			.attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
			.attr('font-size', 10).attr('fill', 'var(--text-muted)').attr('pointer-events', 'none')
			.text(n.isCollapsed ? '▶' : '▼');
		const maxCh = Math.floor((w - tbW - 20) / 7);
		const lbl = n.label.length > maxCh ? n.label.slice(0, maxCh - 1) + '…' : n.label;
		g.append('text')
			.attr('x', -w / 2 + 10).attr('y', (n.isCollapsed && n.excerptCount) ? -6 : 1)
			.attr('dominant-baseline', 'middle')
			.attr('font-size', 12).attr('font-weight', '600')
			.attr('fill', 'var(--text-normal)').text(lbl);
		if (n.isCollapsed && n.excerptCount) {
			g.append('text')
				.attr('x', -w / 2 + 10).attr('y', 10)
				.attr('dominant-baseline', 'middle')
				.attr('font-size', 10).attr('fill', 'var(--text-muted)')
				.text(n.excerptCount + ' excerpt' + (n.excerptCount === 1 ? '' : 's'));
		}
	}

	private drawOrbitExcerptNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {
		const w = O_EXCERPT_W, h = O_EXCERPT_H, rx = 6;
		const ex = this.findExcerptInData(n.id);
		const firstRelType = ex?.relations[0]?.type;
		const relColor = firstRelType
			? (this.plugin.settings.relationTypes.find(r => r.name === firstRelType)?.color ?? null)
			: null;
		g.append('rect')
			.attr('x', -w / 2).attr('y', -h / 2)
			.attr('width', w).attr('height', h).attr('rx', rx)
			.attr('fill', 'var(--background-primary)')
			.attr('stroke', relColor ?? 'var(--background-modifier-border)')
			.attr('stroke-width', relColor ? 1.5 : 0.8)
			.attr('filter', 'url(#em-shadow)');
		g.append('rect')
			.attr('x', -w / 2).attr('y', -h / 2)
			.attr('width', w).attr('height', 4).attr('rx', rx)
			.attr('fill', relColor ?? 'var(--text-faint)').attr('opacity', 0.55);
		const titleLines = this.wrapTextToLines(n.label, Math.floor((w - 14) / 7), 2);
		titleLines.forEach((line, i) => {
			g.append('text')
				.attr('x', -w / 2 + 7).attr('y', -h / 2 + 14 + i * 14)
				.attr('dominant-baseline', 'middle')
				.attr('font-size', 11).attr('font-weight', '600')
				.attr('fill', 'var(--text-normal)').text(line);
		});
		if (n.preview) {
			const maxPCh = Math.floor((w - 14) / 6.5);
			const prev = n.preview.length > maxPCh ? n.preview.slice(0, maxPCh - 1) + '…' : n.preview;
			g.append('text')
				.attr('x', -w / 2 + 7).attr('y', h / 2 - 10)
				.attr('dominant-baseline', 'middle')
				.attr('font-size', 9).attr('fill', 'var(--text-muted)').text(prev);
		}
	}

	// ─── Node Drawers ─────────────────────────────────────────────────────────

	private drawPaperNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {

		const w = PAPER_W, h = PAPER_H, rx = 10;

		const THUMB_W = 68, PAD = 8;

		// Card

		g.append('rect')

			.attr('x', -w / 2).attr('y', -h / 2)

			.attr('width', w).attr('height', h).attr('rx', rx)

			.attr('fill', 'var(--background-secondary)')

			.attr('stroke', n.isVirtual ? 'var(--text-faint)' : 'var(--color-accent)')

			.attr('stroke-width', n.isVirtual ? 1 : 2)

			.attr('stroke-dasharray', n.isVirtual ? '5,3' : 'none')

			.attr('filter', 'url(#em-shadow)');

		// Thumbnail placeholder

		const thumbX = -w / 2 + PAD;

		const thumbY = -h / 2 + PAD;

		const thumbH = h - PAD * 2;

		g.append('rect')

			.attr('class', `em-thumb-bg-${n.id}`)

			.attr('x', thumbX).attr('y', thumbY)

			.attr('width', THUMB_W).attr('height', thumbH)

			.attr('rx', 5)

			.attr('fill', 'var(--background-primary-alt)')

			.attr('stroke', 'var(--background-modifier-border)')

			.attr('stroke-width', 1);

		// Document icon shown while loading

		g.append('text')

			.attr('class', `em-thumb-icon-${n.id}`)

			.attr('x', thumbX + THUMB_W / 2).attr('y', thumbY + thumbH / 2 + 7)

			.attr('text-anchor', 'middle').attr('font-size', 24)

			.attr('fill', 'var(--text-faint)')

			.text('📄');

		// Image element — hidden until thumbnail loads

		g.append('image')

			.attr('class', `em-thumb-img-${n.id}`)

			.attr('x', thumbX).attr('y', thumbY)

			.attr('width', THUMB_W).attr('height', thumbH)

			.attr('preserveAspectRatio', 'xMidYMid slice')

			.attr('clip-path', `inset(0 round 5px)`)

			.style('display', 'none');

		// Vertical divider

		const divX = thumbX + THUMB_W + PAD;

		g.append('line')

			.attr('x1', divX).attr('y1', -h / 2 + 10)

			.attr('x2', divX).attr('y2',  h / 2 - 10)

			.attr('stroke', 'var(--background-modifier-border)')

			.attr('stroke-width', 1);

		// Title

		const textX  = divX + 8;

		const maxW   = w / 2 - textX - 4;

		const maxCh  = Math.floor(maxW / 7.2); // approx chars at 12px

		const titleLines = this.wrapTextToLines(n.label, maxCh > 6 ? maxCh : 16, 3);

		titleLines.forEach((line, i) => {

			g.append('text')

				.attr('x', textX).attr('y', -h / 2 + 22 + i * 16)

				.attr('font-size', 12).attr('font-weight', '700')

				.attr('fill', 'var(--text-normal)')

				.text(line);

		});

		// Authors / year subtitle

		if (n.sub) {

			const sub = n.sub.length > 24 ? n.sub.slice(0, 24) + '…' : n.sub;

			g.append('text')

				.attr('x', textX).attr('y', h / 2 - 10)

				.attr('font-size', 10).attr('fill', 'var(--text-muted)')

				.text(sub);

		}

		if (n.isVirtual) {

			g.append('text')

				.attr('x', textX).attr('y', h / 2 - 10)

				.attr('font-size', 9).attr('fill', 'var(--text-faint)')

				.text('no note yet');

		}

	}

	private drawClaimNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {

		const w = CLAIM_W, h = CLAIM_H, rx = 8;

		// Card

		g.append('rect')

			.attr('x', -w / 2).attr('y', -h / 2)

			.attr('width', w).attr('height', h).attr('rx', rx)

			.attr('fill', 'var(--background-primary)')

			.attr('stroke', 'var(--color-accent)')

			.attr('stroke-width', 2)

			.attr('filter', 'url(#em-shadow)');

		// Left accent bar

		g.append('rect')

			.attr('x', -w / 2).attr('y', -h / 2)

			.attr('width', 5).attr('height', h).attr('rx', rx)

			.attr('fill', 'var(--color-accent)');

		// Claim indicator label

		g.append('text')

			.attr('x', -w / 2 + 14).attr('y', 4)

			.attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')

			.attr('font-size', 8).attr('font-weight', '800')

			.attr('fill', 'var(--color-accent)').attr('opacity', 0.75)

			.text('C');

		// Collapse toggle button (top-right corner)

		const toggleBtnW = 22, toggleBtnH = 16;

		const toggleX = w / 2 - toggleBtnW - 4;

		const toggleY = -h / 2 + 4;

		g.append('rect')

			.attr('x', toggleX).attr('y', toggleY)

			.attr('width', toggleBtnW).attr('height', toggleBtnH)

			.attr('rx', 4)

			.attr('fill', 'var(--background-modifier-hover)')

			.attr('stroke', 'var(--background-modifier-border)')

			.attr('stroke-width', 0.5)

			.attr('data-action', 'toggle-claim')

			.style('cursor', 'pointer');

		g.append('text')

			.attr('x', toggleX + toggleBtnW / 2).attr('y', toggleY + toggleBtnH / 2 + 1)

			.attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')

			.attr('font-size', 9).attr('fill', 'var(--text-muted)')

			.attr('pointer-events', 'none')

			.text(n.isCollapsed ? '▶' : '▼');

		// Main label (slightly narrower to leave room for toggle)

		const maxChars = n.isCollapsed ? 20 : 24;

		const lines      = this.wrapTextToLines(n.label, maxChars, 3);

		const totalH     = lines.length * 15;

		lines.forEach((line, i) => {

			g.append('text')

				.attr('text-anchor', 'middle').attr('x', 0)

				.attr('y', -(totalH / 2) + i * 15 + (n.isCollapsed ? -6 : 4))

				.attr('dominant-baseline', 'middle')

				.attr('font-size', 11).attr('font-weight', '600')

				.attr('fill', 'var(--text-normal)')

				.text(line);

		});

		// Excerpt count badge (shown when collapsed)

		if (n.isCollapsed && n.excerptCount !== undefined) {

			g.append('text')

				.attr('text-anchor', 'middle').attr('x', 0)

				.attr('y', h / 2 - 10)

				.attr('dominant-baseline', 'middle')

				.attr('font-size', 9).attr('fill', 'var(--text-muted)')

				.attr('pointer-events', 'none')

				.text(`${n.excerptCount} excerpt${n.excerptCount === 1 ? '' : 's'} hidden`);

		}

	}

	private drawExcerptNode(g: d3.Selection<SVGGElement, unknown, null, unknown>, n: TreeNode): void {

		const w  = EXCERPT_W;

		const ex = this.findExcerptInData(n.id);

		const h  = ex ? this.getExcerptNodeHeight(ex) : 90;

		const rx = 6;

		const PAD = 10;

		// Pick accent colour from first relation type

		const firstRelType = ex?.relations[0]?.type;

		const relColor = firstRelType

			? (this.plugin.settings.relationTypes.find(r => r.name === firstRelType)?.color ?? null)

			: null;

		// Card

		g.append('rect')

			.attr('x', -w / 2).attr('y', -h / 2)

			.attr('width', w).attr('height', h).attr('rx', rx)

			.attr('fill', 'var(--background-primary)')

			.attr('stroke', relColor ?? 'var(--background-modifier-border)')

			.attr('stroke-width', relColor ? 1.8 : 1)

			.attr('filter', 'url(#em-shadow)');

		// Coloured top band

		g.append('rect')

			.attr('x', -w / 2).attr('y', -h / 2)

			.attr('width', w).attr('height', 5).attr('rx', rx)

			.attr('fill', relColor ?? 'var(--text-faint)')

			.attr('opacity', 0.55);

		// Quotation mark decoration

		g.append('text')

			.attr('x', -w / 2 + PAD).attr('y', -h / 2 + 22)

			.attr('font-size', 20).attr('font-weight', '800')

			.attr('fill', 'var(--text-faint)').attr('opacity', 0.25)

			.text('"');

		// Title

		const titleLines = this.wrapTextToLines(n.label, 36, 2);

		titleLines.forEach((line, i) => {

			g.append('text')

				.attr('x', -w / 2 + 24).attr('y', -h / 2 + 20 + i * 14)

				.attr('font-size', 11).attr('font-weight', '600')

				.attr('fill', 'var(--text-normal)')

				.text(line);

		});

		// Separator below title

		const sepY = -h / 2 + 20 + titleLines.length * 14 + 6;

		g.append('line')

			.attr('x1', -w / 2 + PAD).attr('y1', sepY)

			.attr('x2',  w / 2 - PAD).attr('y2', sepY)

			.attr('stroke', 'var(--background-modifier-border)')

			.attr('stroke-width', 1);

		const contentTop = sepY + 10;

		const footerY    = h / 2 - 8;

		if (n.imagePath) {

			// Image excerpt

			const url    = this.resolveImageUrl(n.imagePath);

			const imgTop = contentTop;

			const imgH   = footerY - imgTop - 12;

			if (url && imgH > 20) {

				g.append('image')

					.attr('x', -w / 2 + PAD).attr('y', imgTop)

					.attr('width', w - PAD * 2).attr('height', imgH)

					.attr('preserveAspectRatio', 'xMidYMid meet')

					.attr('clip-path', `inset(0 round 4px)`)

					.attr('href', url);

			} else {

				g.append('text')

					.attr('x', 0).attr('y', imgTop + 20)

					.attr('text-anchor', 'middle').attr('font-size', 11)

					.attr('fill', 'var(--text-faint)')

					.text('[image]');

			}

		} else if (n.preview) {

			// Text preview

			const previewText = n.preview.slice(0, 500);

			const textLines   = this.wrapTextToLines(previewText, 38, 30);

			textLines.forEach((line, i) => {

				const lineY = contentTop + 11 + i * 13;

				if (lineY + 12 > footerY - 4) return; // clip at footer

				g.append('text')

					.attr('x', -w / 2 + PAD).attr('y', lineY)

					.attr('font-size', 10).attr('fill', 'var(--text-muted)')

					.attr('font-style', 'italic')

					.text(line);

			});

		}

		// Page number footer

		if (n.sub) {

			g.append('text')

				.attr('text-anchor', 'end').attr('x', w / 2 - PAD).attr('y', footerY)

				.attr('font-size', 9).attr('fill', 'var(--text-muted)')

				.text(n.sub);

		}

	}

	// ─── Image helpers ─────────────────────────────────────────────────────────

	private resolveImageUrl(imagePath: string): string | null {

		const file = this.plugin.app.vault.getAbstractFileByPath(imagePath);

		if (!(file instanceof TFile)) return null;

		return this.plugin.app.vault.getResourcePath(file);

	}

	// ─── PDF Thumbnail loading (async) ────────────────────────────────────────

	private async loadThumbnails(nodes: TreeNode[]): Promise<void> {

		for (const node of nodes) {

			if (node.type !== 'paper' || !node.pdfPath || !this.svg) continue;

			const dataUrl = await this.loadPdfThumbnail(node.pdfPath, 68, 104);

			if (!dataUrl || !this.svg) continue;

			const nodeEl    = this.svg.querySelector(`g[data-node-id="${node.id}"]`);

			if (!nodeEl) continue;

			const imgEl     = nodeEl.querySelector(`.em-thumb-img-${node.id}`)      as SVGImageElement | null;

			const bgEl      = nodeEl.querySelector(`.em-thumb-bg-${node.id}`)       as SVGRectElement  | null;

			const iconEl    = nodeEl.querySelector(`.em-thumb-icon-${node.id}`)     as SVGTextElement  | null;

			if (imgEl)  { imgEl.setAttribute('href', dataUrl); imgEl.style.display = ''; }

			if (bgEl)   bgEl.style.display   = 'none';

			if (iconEl) iconEl.style.display  = 'none';

		}

	}

	private async loadPdfThumbnail(pdfPath: string, maxW: number, maxH: number): Promise<string | null> {

		try {

			// eslint-disable-next-line @typescript-eslint/no-explicit-any

			const pdfjsLib = (window as any).pdfjsLib as any;

			if (!pdfjsLib?.getDocument) return null;

			const file = this.plugin.app.vault.getAbstractFileByPath(pdfPath);

			if (!(file instanceof TFile)) return null;

			const data = await this.plugin.app.vault.readBinary(file);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

			const pdf  = await pdfjsLib.getDocument({data}).promise;

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

			const page = await pdf.getPage(1);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

			const originalVp = page.getViewport({scale: 1});

			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access

			const scale      = Math.min(maxW / originalVp.width, maxH / originalVp.height);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

			const viewport   = page.getViewport({scale});

			const canvas  = document.createElement('canvas');

			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access

			canvas.width  = Math.round(viewport.width);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access

			canvas.height = Math.round(viewport.height);

			const ctx     = canvas.getContext('2d');

			if (!ctx) return null;

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access

			await page.render({canvasContext: ctx, viewport}).promise;

			return canvas.toDataURL('image/jpeg', 0.75);

		} catch (e) {

			console.warn('ExcerptManager: PDF thumbnail failed', e);

			return null;

		}

	}

	// ─── Relation Edges ───────────────────────────────────────────────────────

	private drawRelationEdges(

		g: d3.Selection<SVGGElement, unknown, null, unknown>,

		data: GraphData,

		pos: Map<string, {x: number; y: number}>

	): void {

		const edges: Array<{srcId: string; srcType: 'excerpt' | 'claim'; rel: {type: string; targetId: string; targetType: string}}> = [];

		data.papers.forEach(paper => {

			[...paper.claims.flatMap(c => c.excerpts), ...paper.unlinkedExcerpts].forEach(ex => {

				ex.relations.forEach(rel => edges.push({srcId: ex.id, srcType: 'excerpt', rel}));

			});

			paper.claims.forEach(claim => {

				claim.relations.forEach(rel => edges.push({srcId: claim.id, srcType: 'claim', rel}));

			});

		});

		data.orphanClaims.forEach(claim => {

			claim.relations.forEach(rel => edges.push({srcId: claim.id, srcType: 'claim', rel}));

		});

		edges.forEach(({srcId, srcType, rel}) => {

			if (!this.visibleRelationTypes.has(rel.type)) return;

			const color = this.plugin.settings.relationTypes.find(r => r.name === rel.type)?.color ?? '#888';

			const src   = pos.get(srcId);

			const tgt   = pos.get(rel.targetId);

			if (!src || !tgt || (src.x === tgt.x && src.y === tgt.y)) return;

			const mx = (src.x + tgt.x) / 2;

			const my = (src.y + tgt.y) / 2 - 40;

			const pathD = `M${src.x},${src.y} Q${mx},${my} ${tgt.x},${tgt.y}`;

			const markerId = `arrow-${color.replace('#', '')}`;

			if (this.svgEl && !g.select(`#${markerId}`).node()) {

				const defs   = d3.select(this.svgEl).select('defs');

				const marker = defs.append('marker')

					.attr('id', markerId)

					.attr('viewBox', '0 -4 8 8')

					.attr('refX', 8).attr('refY', 0)

					.attr('markerWidth', 6).attr('markerHeight', 6)

					.attr('orient', 'auto');

				marker.append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color);

			}

			g.append('path')

				.attr('fill', 'none')

				.attr('stroke', color).attr('stroke-width', 1.8).attr('opacity', 0.65)

				.attr('stroke-dasharray', '5,3')

				.attr('marker-end', `url(#${markerId})`)

				.attr('d', pathD);

			const capturedSrcId   = srcId;

			const capturedSrcType = srcType;

			const capturedRel     = rel;

			g.append('path')

				.attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 14)

				.attr('d', pathD).style('cursor', 'pointer')

				.on('click', (e: MouseEvent) => { e.stopPropagation(); this.showEdgePopup(e, capturedSrcId, capturedSrcType, capturedRel); });

			g.append('text')

				.attr('x', mx).attr('y', my - 5)

				.attr('text-anchor', 'middle').attr('font-size', 9)

				.attr('fill', color).attr('opacity', 0.85)

				.attr('pointer-events', 'none')

				.text(rel.type);

		});

	}

	// ─── Context Menu ─────────────────────────────────────────────────────────

	private showContextMenu(e: MouseEvent, n: TreeNode): void {

		this.dismissContextMenu();

		this.hideTooltip();

		const menu = document.createElement('div');

		menu.className = 'excerpt-graph-context-menu';

		menu.style.left = `${e.clientX}px`;

		menu.style.top  = `${e.clientY}px`;

		const addRelItem = menu.createEl('div', {cls: 'excerpt-graph-context-item', text: '→ Add relation'});

		addRelItem.addEventListener('click', () => { this.dismissContextMenu(); this.startLinkMode(n); });

		const openItem = menu.createEl('div', {cls: 'excerpt-graph-context-item', text: '↗ Open note'});

		openItem.addEventListener('click', () => {

			this.dismissContextMenu();

			const folder = n.type === 'claim' ? this.plugin.settings.claimFolder : this.plugin.settings.excerptFolder;

			void this.plugin.app.workspace.openLinkText(`${folder}/${n.id}`, '', false);

		});

		if (n.type === 'excerpt') {

			const backItem = menu.createEl('div', {cls: 'excerpt-graph-context-item', text: '↩ Back to source'});

			backItem.addEventListener('click', () => {

				this.dismissContextMenu();

				void this.plugin.pdfNavigator.navigateFromExcerpt(n.id);

			});

		}

		const relations = n.type === 'excerpt'

			? (this.findExcerptInData(n.id)?.relations ?? [])

			: (this.findClaimInData(n.id)?.relations ?? []);

		if (relations.length > 0) {

			menu.createEl('div', {cls: 'excerpt-graph-context-divider'});

			menu.createEl('div', {cls: 'excerpt-graph-context-header', text: 'Relations:'});

			relations.forEach(rel => {

				const row = menu.createDiv({cls: 'excerpt-graph-context-item excerpt-graph-context-rel-item'});

				row.createEl('span', {text: `${rel.type} → ${rel.targetId}`});

				const del = row.createEl('span', {cls: 'excerpt-graph-rel-delete-btn', text: '×'});

				del.addEventListener('click', async (ev) => {

					ev.stopPropagation();

					this.dismissContextMenu();

					await this.deleteRelation(n.id, n.type as 'excerpt' | 'claim', rel);

				});

			});

		}

		menu.createEl('div', {cls: 'excerpt-graph-context-item', text: 'Cancel'})

			.addEventListener('click', () => this.dismissContextMenu());

		document.body.appendChild(menu);

		this.contextMenu = menu;

		const dismiss = (ev: MouseEvent) => {

			if (!menu.contains(ev.target as Node)) {

				this.dismissContextMenu();

				document.removeEventListener('mousedown', dismiss, true);

			}

		};

		setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);

	}

	private showEdgePopup(e: MouseEvent, srcId: string, srcType: 'excerpt' | 'claim', rel: {type: string; targetId: string; targetType: string}): void {

		this.dismissContextMenu();

		this.hideTooltip();

		const menu = document.createElement('div');

		menu.className = 'excerpt-graph-context-menu';

		menu.style.left = `${e.clientX}px`;

		menu.style.top  = `${e.clientY}px`;

		menu.createEl('div', {cls: 'excerpt-graph-context-header', text: `${rel.type} → ${rel.targetId}`});

		const delItem = menu.createEl('div', {cls: 'excerpt-graph-context-item excerpt-graph-context-danger', text: '× Remove this relation'});

		delItem.addEventListener('click', async () => {

			this.dismissContextMenu();

			await this.deleteRelation(srcId, srcType, rel);

		});

		menu.createEl('div', {cls: 'excerpt-graph-context-item', text: 'Cancel'})

			.addEventListener('click', () => this.dismissContextMenu());

		document.body.appendChild(menu);

		this.contextMenu = menu;

		const dismiss = (ev: MouseEvent) => {

			if (!menu.contains(ev.target as Node)) {

				this.dismissContextMenu();

				document.removeEventListener('mousedown', dismiss, true);

			}

		};

		setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);

	}

	// ─── Data helpers ─────────────────────────────────────────────────────────

	private findExcerptInData(id: string): ExcerptNode | undefined {

		for (const paper of this.data.papers) {

			for (const claim of paper.claims) {

				const ex = claim.excerpts.find(e => e.id === id);

				if (ex) return ex;

			}

			const ex = paper.unlinkedExcerpts.find(e => e.id === id);

			if (ex) return ex;

		}

		return undefined;

	}

	private findClaimInData(id: string): import('./GraphDataBuilder').ClaimNode | undefined {

		for (const paper of this.data.papers) {

			const c = paper.claims.find(c => c.id === id);

			if (c) return c;

		}

		return this.data.orphanClaims.find(c => c.id === id);

	}

	private async deleteRelation(

		srcId: string,

		srcType: 'excerpt' | 'claim',

		rel: {type: string; targetId: string; targetType: string}

	): Promise<void> {

		try {

			const {claimFolder, excerptFolder, paperFolder} = this.plugin.settings;

			const targetFolder = rel.targetType === 'claim'  ? claimFolder

			                   : rel.targetType === 'paper'  ? paperFolder

			                   : excerptFolder;

			const targetPath   = `${targetFolder}/${rel.targetId}`;

			let modifiedPath: string;

			if (srcType === 'excerpt') {

				modifiedPath = `${excerptFolder}/${srcId}.md`;

				const file   = this.plugin.app.vault.getAbstractFileByPath(modifiedPath);

				if (!(file instanceof TFile)) { new Notice('Excerpt not found.'); return; }

				const excerpt = this.plugin.store.readExcerpt(file);

				if (!excerpt) { new Notice('Could not read excerpt.'); return; }

				const newRels = excerpt.relations.filter(r => !(r.type === rel.type && r.target === targetPath));

				await this.plugin.store.updateRelations(srcId, newRels);

			} else {

				modifiedPath = `${claimFolder}/${srcId}.md`;

				const file   = this.plugin.app.vault.getAbstractFileByPath(modifiedPath);

				if (!(file instanceof TFile)) { new Notice('Claim not found.'); return; }

				const claim  = this.plugin.claimStore.readClaim(file);

				if (!claim) { new Notice('Could not read claim.'); return; }

				const newRels = claim.relations.filter(r => !(r.type === rel.type && r.target === targetPath));

				await this.plugin.claimStore.updateRelations(srcId, newRels);

			}

			new Notice(`Relation "${rel.type}" removed.`);

			this.rebuildOnCacheUpdate(modifiedPath);

		} catch (err) {

			new Notice(`Failed: ${String(err)}`);

		}

	}

	private rebuildOnCacheUpdate(modifiedFilePath: string): void {

		let done = false;

		const finish = () => {

			if (done) return;

			done = true;

			this.plugin.app.metadataCache.offref(ref);

			clearTimeout(fallback);

			this.data = new GraphDataBuilder(this.plugin).build();

			this.render();

		};

		const ref      = this.plugin.app.metadataCache.on('changed', (file) => { if (file.path === modifiedFilePath) finish(); });

		const fallback = setTimeout(finish, 1500);

	}

	private dismissContextMenu(): void {

		if (this.contextMenu) { this.contextMenu.remove(); this.contextMenu = null; }

	}

	// ─── Link mode ────────────────────────────────────────────────────────────

	private startLinkMode(n: TreeNode): void {

		this.endLinkMode();

		this.linkSource = {id: n.id, type: n.type as 'excerpt' | 'claim', label: n.label};

		const overlay   = document.createElement('div');

		overlay.className = 'excerpt-graph-link-overlay';

		overlay.innerHTML = `<strong>Link mode:</strong> Click another node to link to "<em>${n.label}</em>" &nbsp; <button class="excerpt-graph-link-cancel">Cancel</button>`;

		overlay.querySelector('button')?.addEventListener('click', () => this.endLinkMode());

		this.container.style.cursor = 'crosshair';

		this.container.appendChild(overlay);

		this.linkOverlay = overlay;

	}

	private endLinkMode(): void {

		this.linkSource = null;

		if (this.linkOverlay) { this.linkOverlay.remove(); this.linkOverlay = null; }

		this.container.style.cursor = '';

	}

	private handleLinkTarget(target: TreeNode): void {

		if (!this.linkSource) return;

		if (target.id === this.linkSource.id) { this.endLinkMode(); return; }

		if (target.type !== 'claim' && target.type !== 'excerpt') { this.endLinkMode(); return; }

		const source = this.linkSource;

		this.endLinkMode();

		this.showRelationPicker(source, target);

	}

	private showRelationPicker(

		source: {id: string; type: string; label: string},

		target: {id: string; type: string; label: string}

	): void {

		// Excerpts cannot link directly to papers; only excerpt → claim → paper

		if (source.type === 'excerpt' && target.type === 'paper') return;

		const panel = document.createElement('div');

		panel.className = 'excerpt-graph-rel-picker';

		panel.createEl('div', {cls: 'excerpt-graph-rel-picker-title', text: `Relation: "${source.label}" → "${target.label}"`});

		const presetRow = panel.createDiv({cls: 'excerpt-graph-rel-picker-presets'});

		let selectedType = this.plugin.settings.relationTypes[0]?.name ?? '';

		const pills: HTMLButtonElement[] = [];

		this.plugin.settings.relationTypes.forEach(rt => {

			const btn = presetRow.createEl('button', {cls: 'excerpt-graph-rel-preset-pill', text: rt.name}) as HTMLButtonElement;

			btn.style.borderColor = rt.color;

			if (rt.name === selectedType) btn.classList.add('selected');

			btn.addEventListener('click', () => {

				selectedType = rt.name;

				customInput.value = '';

				pills.forEach(p => p.classList.remove('selected'));

				btn.classList.add('selected');

			});

			pills.push(btn);

		});

		const customRow = panel.createDiv({cls: 'excerpt-graph-rel-picker-custom'});

		customRow.createEl('span', {text: 'Custom: ', cls: 'excerpt-graph-toolbar-label'});

		const customInput = customRow.createEl('input', {

			cls: 'excerpt-graph-rel-custom-input', type: 'text', placeholder: 'e.g. extends, motivates…',

		}) as HTMLInputElement;

		customInput.addEventListener('input', () => {

			if (customInput.value.trim()) {

				selectedType = customInput.value.trim();

				pills.forEach(p => p.classList.remove('selected'));

			} else {

				selectedType = this.plugin.settings.relationTypes[0]?.name ?? '';

				if (pills[0]) pills[0].classList.add('selected');

			}

		});

		const noteRow = panel.createDiv({cls: 'excerpt-graph-rel-picker-custom'});

		noteRow.createEl('span', {text: 'Note: ', cls: 'excerpt-graph-toolbar-label'});

		const noteInput = noteRow.createEl('input', {

			cls: 'excerpt-graph-rel-custom-input', type: 'text', placeholder: 'Optional comment…',

		}) as HTMLInputElement;

		const btnRow    = panel.createDiv({cls: 'excerpt-graph-rel-picker-btns'});

		const createBtn = btnRow.createEl('button', {cls: 'excerpt-graph-rel-create-btn', text: 'Create relation'});

		const cancelBtn = btnRow.createEl('button', {cls: 'excerpt-graph-rel-cancel-btn', text: 'Cancel'});

		cancelBtn.addEventListener('click', () => panel.remove());

		createBtn.addEventListener('click', async () => {

			const relType = customInput.value.trim() || selectedType;

			if (!relType) { new Notice('Select a relation type.'); return; }

			const {claimFolder, excerptFolder, paperFolder} = this.plugin.settings;

			const targetFolder = target.type === 'claim'  ? claimFolder

			                   : target.type === 'paper'  ? paperFolder

			                   : excerptFolder;

			const targetPath   = `${targetFolder}/${target.id}`;

			const newRel: Relation = {

				type:   relType,

				target: targetPath,

				...(noteInput.value.trim() ? {note: noteInput.value.trim()} : {}),

			};

			try {

				let modifiedPath: string;

				if (source.type === 'excerpt') {

					modifiedPath = `${excerptFolder}/${source.id}.md`;

					const file   = this.plugin.app.vault.getAbstractFileByPath(modifiedPath);

					if (!(file instanceof TFile)) { new Notice('Source excerpt not found.'); panel.remove(); return; }

					const excerpt = this.plugin.store.readExcerpt(file);

					if (!excerpt) { new Notice('Could not read excerpt.'); panel.remove(); return; }

					await this.plugin.store.updateRelations(source.id, [...excerpt.relations, newRel]);

				} else {

					modifiedPath = `${claimFolder}/${source.id}.md`;

					const file   = this.plugin.app.vault.getAbstractFileByPath(modifiedPath);

					if (!(file instanceof TFile)) { new Notice('Source claim not found.'); panel.remove(); return; }

					const claim  = this.plugin.claimStore.readClaim(file);

					if (!claim) { new Notice('Could not read claim.'); panel.remove(); return; }

					await this.plugin.claimStore.updateRelations(source.id, [...claim.relations, newRel]);

				}

				await ensureRelationType(this.plugin, relType);

				this.visibleRelationTypes.add(relType);

				new Notice(`Relation created: ${relType}`);

				panel.remove();

				this.rebuildOnCacheUpdate(modifiedPath);

			} catch (err) {

				new Notice(`Failed: ${String(err)}`);

			}

		});

		document.body.appendChild(panel);

		panel.style.left = `${window.innerWidth  / 2 - 180}px`;

		panel.style.top  = `${window.innerHeight / 2 - 100}px`;

		setTimeout(() => {

			const dismiss = (ev: MouseEvent) => {

				if (!panel.contains(ev.target as Node)) { panel.remove(); document.removeEventListener('mousedown', dismiss, true); }

			};

			document.addEventListener('mousedown', dismiss, true);

		}, 0);

	}

	// ─── Text helpers ─────────────────────────────────────────────────────────

	private wrapTextToLines(text: string, maxChars: number, maxLines: number): string[] {

		if (!text) return [];

		const words  = text.split(/\s+/);

		const lines: string[] = [];

		let current  = '';

		let wordIdx  = 0;

		while (wordIdx < words.length && lines.length < maxLines) {

			const word = words[wordIdx]!;

			const test = current ? `${current} ${word}` : word;

			if (test.length > maxChars) {

				if (current) {

					lines.push(current);

					current = '';

				} else {

					lines.push(word.slice(0, maxChars - 1) + '…');

					current = '';

					wordIdx++;

				}

			} else {

				current = test;

				wordIdx++;

			}

		}

		if (current && lines.length < maxLines) lines.push(current);

		// Ellipsis on last line if there's more text

		if (wordIdx < words.length && lines.length > 0) {

			const last = lines[lines.length - 1]!;

			lines[lines.length - 1] = last.length < maxChars ? last + '…' : last.slice(0, maxChars - 1) + '…';

		}

		return lines;

	}

	// ─── Export ───────────────────────────────────────────────────────────────

	getSvgElement(): SVGSVGElement | null { return this.svg; }

	exportAsSvg(): void {

		if (!this.svg) return;

		const blob = new Blob([new XMLSerializer().serializeToString(this.svg)], {type: 'image/svg+xml'});

		const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: 'excerpt-graph.svg'});

		a.click();

		URL.revokeObjectURL(a.href);

	}

	exportAsJson(data: GraphData): void {

		const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});

		const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: 'excerpt-graph.json'});

		a.click();

		URL.revokeObjectURL(a.href);

	}

}

