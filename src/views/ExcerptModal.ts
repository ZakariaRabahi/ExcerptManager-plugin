import {Modal, Notice, Setting} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {SelectionData} from '../pdf/PdfAnnotator';

export class ExcerptModal extends Modal {
	private plugin: ExcerptManagerPlugin;
	private selectionData: SelectionData;

	private label = '';
	private tags = '';

	constructor(plugin: ExcerptManagerPlugin, selectionData: SelectionData) {
		super(plugin.app);
		this.plugin = plugin;
		this.selectionData = selectionData;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('excerpt-manager-modal');

		contentEl.createEl('h2', {text: 'New Excerpt'});

		const isImage = Boolean(this.selectionData.imageData);

		// --- Preview ---
		if (isImage) {
			const img = contentEl.createEl('img', {cls: 'excerpt-manager-image-preview'});
			img.src = `data:image/png;base64,${this.selectionData.imageData!}`;
		} else {
			const previewText = this.selectionData.text.length > 300
				? this.selectionData.text.slice(0, 300) + '…'
				: this.selectionData.text;
			const preview = contentEl.createEl('blockquote', {cls: 'excerpt-manager-preview'});
			preview.setText(previewText);
		}

		// --- Source info ---
		const sourceFilename = this.selectionData.sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? this.selectionData.sourcePath;
		const sourceInfo = this.selectionData.sourceType === 'note'
			? `Source: ${sourceFilename}`
			: `Source: ${sourceFilename}, p. ${this.selectionData.page}`;
		contentEl.createEl('p', {
			text: sourceInfo,
			cls: 'excerpt-manager-source-info',
		});

		// --- Label ---
		let labelInput: HTMLInputElement;
		new Setting(contentEl)
			.setName('Label')
			.setDesc('Short summary or claim')
			.addText(text => {
				text.setPlaceholder('Short summary or claim...');
				labelInput = text.inputEl;
				text.onChange(value => { this.label = value; });
				// slight delay so the modal is fully visible before focusing
				setTimeout(() => text.inputEl.focus(), 50);
			});

		// --- Tags ---
		new Setting(contentEl)
			.setName('Tags')
			.setDesc('Comma-separated')
			.addText(text => {
				text.setPlaceholder('tag1, tag2, tag3');
				text.onChange(value => { this.tags = value; });
				// Allow Enter on the tags field to submit
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); void this.save(); }
				});
			});

		// Allow Enter on the label field to submit
		labelInput!.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void this.save(); }
		});

		// --- Buttons ---
		const buttonRow = new Setting(contentEl);
		buttonRow
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => void this.save()))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	private async save(): Promise<void> {
		if (!this.label.trim()) {
			new Notice('Label is required.');
			return;
		}
		const isImage = Boolean(this.selectionData.imageData);
		if (!isImage && !this.selectionData.text.trim()) {
			new Notice('Selection text is empty.');
			return;
		}

		const tags = this.tags
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);

		try {
			let source: string;
			if (this.selectionData.sourceType === 'note') {
				// Note-based excerpt: use the note path directly as source (no paper lookup)
				source = this.selectionData.sourcePath.replace(/\.md$/i, '');
			} else {
				const paper = await this.plugin.paperStore.findOrCreatePaper(this.selectionData.sourcePath);
				source = `${this.plugin.settings.paperFolder}/${paper.id}`;
			}

			await this.plugin.store.createExcerpt(
				{
					label: this.label.trim(),
					source,
					page: this.selectionData.page,
					selectionText: isImage ? '' : this.selectionData.text,
					...(this.selectionData.selectionRange ? {selectionRange: this.selectionData.selectionRange} : {}),
					...(this.selectionData.selectionRects ? {selectionRects: this.selectionData.selectionRects} : {}),
					tags,
					relations: [],
				},
				this.selectionData.imageData,
			);

			new Notice(`Excerpt created: ${this.label.trim()}`);
			this.close();
		} catch (err) {
			new Notice(`Failed to save excerpt: ${String(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
