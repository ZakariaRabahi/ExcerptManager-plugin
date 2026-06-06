import {Modal, Notice, Setting, TFile} from 'obsidian';
import ExcerptManagerPlugin from '../main';
import {Excerpt} from '../core/types';
import {LinkToClaimModal} from './LinkToClaimModal';
import {EditSourceModal} from './EditSourceModal';

export class EditExcerptModal extends Modal {
	private plugin: ExcerptManagerPlugin;
	private excerptId: string;
	private onSaved: () => void;

	private excerpt: Excerpt | null = null;
	private label = '';
	private tags = '';
	private relationsContainer: HTMLElement | null = null;

	constructor(plugin: ExcerptManagerPlugin, excerptId: string, onSaved: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.excerptId = excerptId;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const {excerptFolder} = this.plugin.settings;
		const file = this.plugin.app.vault.getAbstractFileByPath(
			`${excerptFolder}/${this.excerptId}.md`
		);
		if (!(file instanceof TFile)) {
			new Notice(`Excerpt not found: ${this.excerptId}`);
			this.close();
			return;
		}

		this.excerpt = this.plugin.store.readExcerpt(file);
		if (!this.excerpt) {
			new Notice(`Could not read excerpt: ${this.excerptId}`);
			this.close();
			return;
		}

		this.label = this.excerpt.label;
		this.tags = this.excerpt.tags.join(', ');

		this.render();
	}

	private render(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('excerpt-manager-modal');

		if (!this.excerpt) return;

		contentEl.createEl('h2', {text: 'Edit Excerpt'});

		// --- Metadata section ---
		contentEl.createEl('h3', {text: 'Metadata'});

		new Setting(contentEl)
			.setName('Label')
			.setDesc('Short summary or claim (required)')
			.addText(text => {
				text.setValue(this.label);
				text.setPlaceholder('Short summary or claim...');
				text.onChange(v => { this.label = v; });
				setTimeout(() => text.inputEl.focus(), 50);
			});

		new Setting(contentEl)
			.setName('Tags')
			.setDesc('Comma-separated')
			.addText(text => {
				text.setValue(this.tags);
				text.setPlaceholder('tag1, tag2, tag3');
				text.onChange(v => { this.tags = v; });
			});

		// Change source button
		const changeSourceSetting = new Setting(contentEl)
			.setName('Source selection')
			.setDesc(`p. ${this.excerpt.page} — ${this.excerpt.selectionText.slice(0, 60)}${this.excerpt.selectionText.length > 60 ? '…' : ''}`);
		changeSourceSetting.addButton(btn => btn
			.setButtonText('Change source')
			.onClick(() => {
				if (!this.excerpt) return;
				new EditSourceModal(this.plugin, this.excerpt, () => {
					// Reload excerpt after source change
					const excerptFolder = this.plugin.settings.excerptFolder;
					const f = this.plugin.app.vault.getAbstractFileByPath(
						`${excerptFolder}/${this.excerptId}.md`
					);
					if (f instanceof TFile) {
						this.excerpt = this.plugin.store.readExcerpt(f);
					}
					this.renderRelations();
				}).open();
			})
		);

		// --- Relations section ---
		contentEl.createEl('h3', {text: 'Relations'});

		this.relationsContainer = contentEl.createDiv();
		this.renderRelations();

		// Add relation button
		const addRelBtn = contentEl.createEl('button', {text: '+ Add relation', cls: 'mod-cta'});
		addRelBtn.style.marginTop = '6px';
		addRelBtn.addEventListener('click', () => {
			if (!this.excerpt) return;
			new LinkToClaimModal(this.plugin, this.excerpt, () => {
				// Reload excerpt after linking
				const excerptFolder = this.plugin.settings.excerptFolder;
				const f = this.plugin.app.vault.getAbstractFileByPath(
					`${excerptFolder}/${this.excerptId}.md`
				);
				if (f instanceof TFile) {
					this.excerpt = this.plugin.store.readExcerpt(f);
				}
				this.renderRelations();
			}).open();
		});

		// --- Buttons ---
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Save')
				.setCta()
				.onClick(() => void this.save()))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));
	}

	private renderRelations(): void {
		if (!this.relationsContainer || !this.excerpt) return;
		this.relationsContainer.empty();

		if (this.excerpt.relations.length === 0) {
			this.relationsContainer.createEl('p', {
				text: 'No relations yet.',
				cls: 'excerpt-manager-source-info',
			});
			return;
		}

		this.excerpt.relations.forEach((rel, index) => {
			const row = this.relationsContainer!.createDiv({cls: 'excerpt-relation-row'});
			row.createEl('span', {
				cls: 'excerpt-relation-type',
				text: rel.type,
			});
			row.createEl('span', {text: ' → '});
			row.createEl('span', {text: rel.target});

			const removeBtn = row.createEl('button', {text: 'Remove'});
			removeBtn.style.marginLeft = 'auto';
			removeBtn.addEventListener('click', async () => {
				try {
					await this.plugin.store.removeRelation(this.excerptId, index);
					// Reload excerpt
					const excerptFolder = this.plugin.settings.excerptFolder;
					const f = this.plugin.app.vault.getAbstractFileByPath(
						`${excerptFolder}/${this.excerptId}.md`
					);
					if (f instanceof TFile) {
						this.excerpt = this.plugin.store.readExcerpt(f);
					}
					this.renderRelations();
				} catch (e) {
					new Notice(`Failed to remove relation: ${String(e)}`);
				}
			});
		});
	}

	private async save(): Promise<void> {
		if (!this.label.trim()) {
			new Notice('Label is required.');
			return;
		}
		const tags = this.tags
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);

		try {
			await this.plugin.store.updateExcerptMeta(this.excerptId, this.label.trim(), tags);
			new Notice('Excerpt updated.');
			this.onSaved();
			this.close();
		} catch (e) {
			new Notice(`Failed to save: ${String(e)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
