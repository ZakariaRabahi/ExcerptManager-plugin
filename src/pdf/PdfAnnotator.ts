import {WorkspaceLeaf} from 'obsidian';
import ExcerptManagerPlugin from '../main';

export interface SelectionData {
	text: string;
	page: number;
	sourcePath: string;        // vault path to the source (PDF or markdown note)
	sourceType: 'pdf' | 'note';
	selectionRange?: string;   // "startIdx,startOffset,endIdx,endOffset" for exact re-highlighting
	selectionRects?: number[][];  // Normalised [x,y,w,h] bounding boxes for RSL selector
	imageData?: string;        // base64 PNG (no data: prefix) for image excerpts
}

export class PdfAnnotator {
	private plugin: ExcerptManagerPlugin;
	onCreateExcerpt: ((data: SelectionData) => void) | null = null;

	private currentContainer: HTMLElement | null = null;
	private mouseupHandler: ((e: MouseEvent) => void) | null = null;
	private mousedownHandler: ((e: MouseEvent) => void) | null = null;
	private dismissHandler: ((e: MouseEvent) => void) | null = null;
	private button: HTMLElement | null = null;
	private leafChangeRef: (() => void) | null = null;
	private captureMode: ((data: SelectionData) => void) | null = null;

	// Image region selection state
	private imageSelecting = false;
	private imageSelStart: {x: number; y: number} | null = null;
	private imageSelOverlay: HTMLElement | null = null;
	private imageCaptureLeaf: WorkspaceLeaf | null = null;
	private imgMoveHandler: ((e: MouseEvent) => void) | null = null;
	private imgUpHandler: ((e: MouseEvent) => void) | null = null;
	private attachPdfTimeout: ReturnType<typeof setTimeout> | null = null;

	captureNextSelection(callback: (data: SelectionData) => void): void {
		this.captureMode = callback;
	}

	cancelCapture(): void {
		this.captureMode = null;
	}

	constructor(plugin: ExcerptManagerPlugin) {
		this.plugin = plugin;
	}

	enable(): void {
		const activeLeaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (activeLeaf) this.attachToLeaf(activeLeaf);

		this.leafChangeRef = this.plugin.app.workspace.on('active-leaf-change', (leaf) => {
			this.detachFromLeaf();
			if (leaf) this.attachToLeaf(leaf);
		}) as unknown as () => void;
	}

	disable(): void {
		this.detachFromLeaf();
		if (this.leafChangeRef) {
			this.plugin.app.workspace.offref(this.leafChangeRef as unknown as ReturnType<typeof this.plugin.app.workspace.on>);
			this.leafChangeRef = null;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private isPdfLeaf(leaf: WorkspaceLeaf): boolean {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const viewType = (leaf.view as any)?.getViewType?.();
		return viewType === 'pdf';
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private isMarkdownLeaf(leaf: WorkspaceLeaf): boolean {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const viewType = (leaf.view as any)?.getViewType?.();
		return viewType === 'markdown';
	}

	attachToLeaf(leaf: WorkspaceLeaf): void {
		if (this.isPdfLeaf(leaf)) {
			this.attachToPdfLeaf(leaf);
		} else if (this.isMarkdownLeaf(leaf)) {
			this.attachToMarkdownLeaf(leaf);
		}
	}

	private attachToMarkdownLeaf(leaf: WorkspaceLeaf): void {
		setTimeout(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const viewEl: HTMLElement | undefined = (leaf.view as any)?.contentEl;
			if (!viewEl) return;
			this.currentContainer = viewEl;
			this.mouseupHandler = (e: MouseEvent) => this.handleMarkdownMouseUp(e, leaf);
			viewEl.addEventListener('mouseup', this.mouseupHandler);
		}, 200);
	}

	private handleMarkdownMouseUp(e: MouseEvent, leaf: WorkspaceLeaf): void {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sourcePath: string = (leaf.view as any)?.file?.path ?? '';
		if (!sourcePath) return;
		this.showCreateButton(
			{x: e.clientX, y: e.clientY},
			{text: selection.toString().trim(), page: 0, sourcePath, sourceType: 'note'},
		);
	}

	private attachToPdfLeaf(leaf: WorkspaceLeaf): void {
		if (!this.isPdfLeaf(leaf)) return;
		if (this.attachPdfTimeout !== null) { clearTimeout(this.attachPdfTimeout); this.attachPdfTimeout = null; }

		this.attachPdfTimeout = setTimeout(() => {
			this.attachPdfTimeout = null;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const viewEl: HTMLElement | undefined = (leaf.view as any)?.contentEl;
			if (!viewEl) return;

			const container: HTMLElement | null =
				viewEl.querySelector('.pdf-viewer') ??
				viewEl.querySelector('.pdf-embed') ??
				viewEl;

			if (!container) return;

			this.currentContainer = container;

			this.mousedownHandler = (e: MouseEvent) => this.handleMouseDown(e, leaf);
			this.mouseupHandler   = (e: MouseEvent) => this.handleMouseUp(e, leaf);
			container.addEventListener('mousedown', this.mousedownHandler);
			container.addEventListener('mouseup',   this.mouseupHandler);
		}, 500);
	}

	detachFromLeaf(): void {
		if (this.attachPdfTimeout !== null) { clearTimeout(this.attachPdfTimeout); this.attachPdfTimeout = null; }
		if (this.currentContainer) {
			if (this.mousedownHandler) this.currentContainer.removeEventListener('mousedown', this.mousedownHandler);
			if (this.mouseupHandler)   this.currentContainer.removeEventListener('mouseup',   this.mouseupHandler);
		}
		this.abortImageSelection();
		this.currentContainer  = null;
		this.mousedownHandler  = null;
		this.mouseupHandler    = null;
		this.removeButton();
	}

	// ─── Mouse-down: start image region selection when Alt is held ────────────

	private handleMouseDown(e: MouseEvent, leaf: WorkspaceLeaf): void {
		if (!e.altKey) return;

		e.preventDefault();   // prevent text selection while dragging
		e.stopPropagation();

		this.abortImageSelection();   // clean up any orphaned overlay from a previous drag
		this.imageSelecting   = true;
		this.imageSelStart    = {x: e.clientX, y: e.clientY};
		this.imageCaptureLeaf = leaf;

		// Draw selection overlay
		const overlay = document.createElement('div');
		overlay.style.cssText = [
			'position:fixed',
			`left:${e.clientX}px`,
			`top:${e.clientY}px`,
			'width:0',
			'height:0',
			'border:2px dashed #2196F3',
			'background:rgba(33,150,243,0.08)',
			'pointer-events:none',
			'z-index:9998',
			'box-sizing:border-box',
		].join(';');
		document.body.appendChild(overlay);
		this.imageSelOverlay = overlay;

		// Attach document-level move/up so drag works outside the container
		this.imgMoveHandler = (ev: MouseEvent) => this.handleImageMouseMove(ev);
		this.imgUpHandler   = (ev: MouseEvent) => this.handleImageMouseUp(ev);
		document.addEventListener('mousemove', this.imgMoveHandler);
		document.addEventListener('mouseup',   this.imgUpHandler);
	}

	private handleImageMouseMove(e: MouseEvent): void {
		if (!this.imageSelecting || !this.imageSelStart || !this.imageSelOverlay) return;
		const x = Math.min(e.clientX, this.imageSelStart.x);
		const y = Math.min(e.clientY, this.imageSelStart.y);
		const w = Math.abs(e.clientX - this.imageSelStart.x);
		const h = Math.abs(e.clientY - this.imageSelStart.y);
		this.imageSelOverlay.style.left   = `${x}px`;
		this.imageSelOverlay.style.top    = `${y}px`;
		this.imageSelOverlay.style.width  = `${w}px`;
		this.imageSelOverlay.style.height = `${h}px`;
	}

	private handleImageMouseUp(e: MouseEvent): void {
		if (!this.imageSelecting || !this.imageSelStart) { this.abortImageSelection(); return; }

		const start = this.imageSelStart;
		const end   = {x: e.clientX, y: e.clientY};
		this.abortImageSelection();   // clean up overlay + handlers

		const w = Math.abs(end.x - start.x);
		const h = Math.abs(end.y - start.y);
		if (w < 10 || h < 10) return;  // ignore tiny accidental drags

		const imageData = this.captureRegion(start, end);
		if (!imageData) {
			this.plugin.app.workspace.trigger('notice', 'Could not capture this region.');
			return;
		}

		const midX      = (start.x + end.x) / 2;
		const midY      = (start.y + end.y) / 2;
		const pageEl    = this.getPageElementFromPoint(midX, midY);
		const page      = this.getPageNumberFromElement(pageEl);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sourcePath = (this.imageCaptureLeaf?.view as any)?.file?.path ?? '';

		this.showCreateButton(
			{x: end.x, y: end.y},
			{text: '', page, sourcePath, sourceType: 'pdf', imageData},
		);
		this.imageCaptureLeaf = null;
	}

	private abortImageSelection(): void {
		this.imageSelecting = false;
		this.imageSelStart  = null;
		if (this.imageSelOverlay) { this.imageSelOverlay.remove(); this.imageSelOverlay = null; }
		if (this.imgMoveHandler) { document.removeEventListener('mousemove', this.imgMoveHandler); this.imgMoveHandler = null; }
		if (this.imgUpHandler)   { document.removeEventListener('mouseup',   this.imgUpHandler);   this.imgUpHandler   = null; }
	}

	// ─── Canvas region capture ────────────────────────────────────────────────

	private captureRegion(start: {x: number; y: number}, end: {x: number; y: number}): string | null {
		// Find the .page element at the centre of the selection
		const midX   = (start.x + end.x) / 2;
		const midY   = (start.y + end.y) / 2;
		const pageEl = this.getPageElementFromPoint(midX, midY);
		if (!pageEl) return null;

		const canvas = pageEl.querySelector('canvas');
		if (!canvas) return null;

		const rect   = canvas.getBoundingClientRect();
		const scaleX = canvas.width  / rect.width;
		const scaleY = canvas.height / rect.height;

		const sx = Math.max(0, (Math.min(start.x, end.x) - rect.left) * scaleX);
		const sy = Math.max(0, (Math.min(start.y, end.y) - rect.top)  * scaleY);
		const sw = Math.min(canvas.width  - sx, Math.abs(end.x - start.x) * scaleX);
		const sh = Math.min(canvas.height - sy, Math.abs(end.y - start.y) * scaleY);
		if (sw <= 0 || sh <= 0) return null;

		try {
			const off = document.createElement('canvas');
			off.width  = Math.round(sw);
			off.height = Math.round(sh);
			const ctx  = off.getContext('2d');
			if (!ctx) return null;
			ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
			const dataUrl = off.toDataURL('image/png');
			return dataUrl.split(',')[1] ?? null;  // return raw base64
		} catch {
			return null;  // canvas tainted (shouldn't happen with local PDF.js)
		}
	}

	private getPageElementFromPoint(x: number, y: number): HTMLElement | null {
		let node: Element | null = document.elementFromPoint(x, y);
		while (node && node instanceof HTMLElement) {
			if (node.classList.contains('page')) return node;
			node = node.parentElement;
		}
		return null;
	}

	private getPageNumberFromElement(el: HTMLElement | null): number {
		if (!el) return 1;
		const attr = el.getAttribute('data-page-number');
		return attr ? parseInt(attr, 10) : 1;
	}

	// ─── Mouse-up: text selection (existing) ─────────────────────────────────

	private handleMouseUp(e: MouseEvent, leaf: WorkspaceLeaf): void {
		// Skip if we just finished an image region drag
		if (this.imageSelecting) return;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.toString().trim()) {
			return;
		}

		const selectedText = selection.toString();
		const pageNumber   = this.getPageNumber(selection);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const sourcePath: string = (leaf.view as any)?.file?.path ?? '';

		const selectionRange =
			this.getRangeViaInternalApi(leaf, selection) ??
			this.getSelectionRange(selection) ??
			undefined;

		const selectionRects = this.getSelectionRects(selection);

		this.showCreateButton(
			{x: e.clientX, y: e.clientY},
			{text: selectedText, page: pageNumber, sourcePath, sourceType: 'pdf', selectionRange, selectionRects},
		);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private getRangeViaInternalApi(leaf: WorkspaceLeaf, selection: Selection): string | null {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const view  = leaf.view as any;
			const child =
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				view?.viewer?.child ??
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				view?.pdfViewer?.child ??
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				view?.child;

			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (!child || typeof child.getTextSelectionRangeStr !== 'function') return null;

			const pageEl = this.getPageElement(selection);
			if (!pageEl) return null;

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
			const result: string | null | undefined = child.getTextSelectionRangeStr(pageEl);
			return result ?? null;
		} catch {
			return null;
		}
	}

	private getPageElement(selection: Selection): HTMLElement | null {
		const anchor = selection.anchorNode;
		if (!anchor) return null;
		let node: Node | null = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
		while (node && node instanceof HTMLElement) {
			if (node.classList.contains('page')) return node;
			node = node.parentElement;
		}
		return null;
	}

	private getSelectionRange(selection: Selection): string | null {
		if (selection.rangeCount === 0) return null;
		const range = selection.getRangeAt(0);

		const getTextLayerChild = (node: Node): HTMLElement | null => {
			let cur: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
			while (cur instanceof HTMLElement) {
				if (cur.parentElement?.classList.contains('textLayer')) return cur;
				cur = cur.parentElement;
			}
			return null;
		};

		const startSpan = getTextLayerChild(range.startContainer);
		const endSpan   = getTextLayerChild(range.endContainer);
		if (!startSpan || !endSpan) return null;

		const startIdx = (startSpan as HTMLElement).dataset['idx'];
		const endIdx   = (endSpan   as HTMLElement).dataset['idx'];
		if (startIdx === undefined || endIdx === undefined) return null;

		const getOffset = (span: HTMLElement, container: Node, containerOffset: number): number => {
			let offset = 0;
			for (const child of Array.from(span.childNodes)) {
				if (child === container) return offset + containerOffset;
				if (child.nodeType === Node.TEXT_NODE) {
					offset += (child as Text).length;
				} else {
					for (const grandchild of Array.from(child.childNodes)) {
						if (grandchild === container) return offset + containerOffset;
						if (grandchild.nodeType === Node.TEXT_NODE) offset += (grandchild as Text).length;
					}
				}
			}
			return offset;
		};

		const startOff = getOffset(startSpan, range.startContainer, range.startOffset);
		const endOff   = getOffset(endSpan,   range.endContainer,   range.endOffset);

		return `${startIdx},${startOff},${endIdx},${endOff}`;
	}

	private getSelectionRects(selection: Selection): number[][] | undefined {
		if (selection.rangeCount === 0) return undefined;
		const range    = selection.getRangeAt(0);
		const pageEl   = this.getPageElement(selection);
		if (!pageEl) return undefined;

		const pageRect = pageEl.getBoundingClientRect();
		if (pageRect.width === 0 || pageRect.height === 0) return undefined;

		const rects: number[][] = [];
		const clientRects = range.getClientRects();
		for (let i = 0; i < clientRects.length; i++) {
			const r = clientRects[i]!;
			if (r.width < 1 || r.height < 1) continue; // skip degenerate rects
			rects.push([
				(r.left   - pageRect.left) / pageRect.width,
				(r.top    - pageRect.top)  / pageRect.height,
				r.width   / pageRect.width,
				r.height  / pageRect.height,
			].map(v => Math.round(v * 10000) / 10000)); // 4 decimal precision
		}
		return rects.length > 0 ? rects : undefined;
	}

	private getPageNumber(selection: Selection): number {
		const anchor = selection.anchorNode;
		if (!anchor) return 1;
		let node: Node | null = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
		while (node && node instanceof HTMLElement) {
			if (node.classList.contains('page')) {
				const attr = node.getAttribute('data-page-number');
				if (attr) return parseInt(attr, 10);
			}
			node = node.parentElement;
		}
		return 1;
	}

	// ─── Floating button ─────────────────────────────────────────────────────

	showCreateButton(position: {x: number; y: number}, selectionData: SelectionData): void {
		this.removeButton();

		const btn = document.createElement('button');
		btn.className = 'excerpt-manager-create-btn';
		btn.style.left = `${position.x + 8}px`;
		btn.style.top  = `${position.y - 36}px`;

		const isImage = Boolean(selectionData.imageData);

		if (this.captureMode) {
			btn.textContent = '✓ Use this selection';
			btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
			btn.addEventListener('click', () => {
				const cb = this.captureMode;
				this.captureMode = null;
				this.removeButton();
				if (cb) cb(selectionData);
			});
		} else {
			btn.textContent = isImage ? 'Create Image Excerpt' : 'Create Excerpt';
			btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
			btn.addEventListener('click', () => {
				this.removeButton();
				if (this.onCreateExcerpt) this.onCreateExcerpt(selectionData);
			});
		}

		document.body.appendChild(btn);
		this.button = btn;

		this.dismissHandler = (e: MouseEvent) => {
			if (e.target !== btn) this.removeButton();
		};
		document.addEventListener('mousedown', this.dismissHandler, {capture: true});
	}

	private removeButton(): void {
		if (this.button) { this.button.remove(); this.button = null; }
		if (this.dismissHandler) {
			document.removeEventListener('mousedown', this.dismissHandler, {capture: true});
			this.dismissHandler = null;
		}
	}
}
