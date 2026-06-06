import {Modal, Notice, TFile} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {Excerpt} from '../core/types';
import {SelectionData} from '../pdf/PdfAnnotator';

export class EditSourceModal extends Modal {
	private plugin: ExcerptManagerPlugin;
	private excerpt: Excerpt;
	private onSaved: () => void;

	private pendingSelection: SelectionData | null = null;
	private waitingEl: HTMLElement | null = null;
	private cancelCaptureBtn: HTMLElement | null = null;
	private newSelectionPreview: HTMLElement | null = null;
	private saveBtn: HTMLButtonElement | null = null;

	constructor(plugin: ExcerptManagerPlugin, excerpt: Excerpt, onSaved: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.excerpt = excerpt;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('excerpt-manager-modal');

		contentEl.createEl('h2', {text: 'Change Source Selection'});

		// Current selection preview
		const previewText = this.excerpt.selectionText.length > 300
			? this.excerpt.selectionText.slice(0, 300) + '…'
			: this.excerpt.selectionText;
		const preview = contentEl.createEl('blockquote', {cls: 'excerpt-manager-preview'});
		preview.setText(previewText);

		// Source info
		const sourceName = this.excerpt.source.split('/').pop() ?? this.excerpt.source;
		contentEl.createEl('p', {
			text: `Source: ${sourceName}, p. ${this.excerpt.page}`,
			cls: 'excerpt-manager-source-info',
		});

		// Go to PDF button + waiting state
		const goRow = contentEl.createDiv();
		goRow.style.marginBottom = '8px';

		const goBtn = goRow.createEl('button', {text: 'Go to PDF', cls: 'mod-cta'});
		this.waitingEl = goRow.createEl('span', {text: ' Waiting for selection...'});
		this.waitingEl.style.fontSize = '12px';
		this.waitingEl.style.color = 'var(--text-faint)';
		this.waitingEl.style.display = 'none';

		this.cancelCaptureBtn = goRow.createEl('button', {text: 'Cancel capture'});
		this.cancelCaptureBtn.style.marginLeft = '8px';
		this.cancelCaptureBtn.style.display = 'none';

		goBtn.addEventListener('click', async () => {
			// Resolve PDF path from paper note
			const paperFile = this.plugin.app.vault.getAbstractFileByPath(this.excerpt.source + '.md')
				?? this.plugin.app.vault.getAbstractFileByPath(this.excerpt.source);

			let pdfPath = '';
			if (paperFile instanceof TFile) {
				const paper = this.plugin.paperStore.readPaper(paperFile);
				if (paper?.pdfPath) pdfPath = paper.pdfPath;
			}

			if (pdfPath) {
				await this.plugin.pdfNavigator.navigateToSource(pdfPath, this.excerpt.page, this.excerpt.selectionRange);
			} else {
				new Notice('Could not resolve PDF path from source.');
				return;
			}

			// Show waiting state
			if (this.waitingEl) this.waitingEl.style.display = '';
			if (this.cancelCaptureBtn) this.cancelCaptureBtn.style.display = '';

			// Start capture mode
			this.plugin.pdfAnnotator.captureNextSelection((data: SelectionData) => {
				this.pendingSelection = data;
				if (this.waitingEl) this.waitingEl.style.display = 'none';
				if (this.cancelCaptureBtn) this.cancelCaptureBtn.style.display = 'none';
				this.renderNewSelectionPreview();
				if (this.saveBtn) this.saveBtn.disabled = false;
			});
		});

		this.cancelCaptureBtn.addEventListener('click', () => {
			this.plugin.pdfAnnotator.cancelCapture();
			if (this.waitingEl) this.waitingEl.style.display = 'none';
			if (this.cancelCaptureBtn) this.cancelCaptureBtn.style.display = 'none';
		});

		// New selection preview area
		this.newSelectionPreview = contentEl.createDiv();

		// Buttons
		const buttonRow = contentEl.createDiv();
		buttonRow.style.display = 'flex';
		buttonRow.style.gap = '8px';
		buttonRow.style.marginTop = '12px';

		this.saveBtn = buttonRow.createEl('button', {text: 'Save', cls: 'mod-cta'}) as HTMLButtonElement;
		this.saveBtn.disabled = true;
		this.saveBtn.addEventListener('click', () => void this.save());

		const cancelBtn = buttonRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => {
			this.plugin.pdfAnnotator.cancelCapture();
			this.close();
		});
	}

	private renderNewSelectionPreview(): void {
		if (!this.newSelectionPreview || !this.pendingSelection) return;
		this.newSelectionPreview.empty();

		this.newSelectionPreview.createEl('p', {
			text: 'New selection:',
			cls: 'excerpt-manager-source-info',
		});

		const newPreviewText = this.pendingSelection.text.length > 300
			? this.pendingSelection.text.slice(0, 300) + '…'
			: this.pendingSelection.text;
		const newPreview = this.newSelectionPreview.createEl('blockquote', {cls: 'excerpt-manager-preview'});
		newPreview.setText(newPreviewText);

		const clearLink = this.newSelectionPreview.createEl('span', {
			text: 'Clear',
			cls: 'excerpt-back-link',
		});
		clearLink.addEventListener('click', () => {
			this.pendingSelection = null;
			if (this.newSelectionPreview) this.newSelectionPreview.empty();
			if (this.saveBtn) this.saveBtn.disabled = true;
		});
	}

	private async save(): Promise<void> {
		if (!this.pendingSelection) {
			new Notice('No selection captured yet.');
			return;
		}
		try {
			await this.plugin.store.updateExcerptSource(
				this.excerpt.id,
				this.pendingSelection.text,
				this.pendingSelection.selectionRange,
			);
			new Notice('Selection updated.');
			this.onSaved();
			this.close();
		} catch (e) {
			new Notice(`Failed to update source: ${String(e)}`);
		}
	}

	onClose(): void {
		this.plugin.pdfAnnotator.cancelCapture();
		this.contentEl.empty();
	}
}
