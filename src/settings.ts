import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import ExcerptManagerPlugin from "./main";
import {DEFAULT_SETTINGS, ExcerptManagerSettings, RelationType} from "./core/types";

export type {ExcerptManagerSettings};
export {DEFAULT_SETTINGS} from "./core/types";

export class ExcerptManagerSettingTab extends PluginSettingTab {
	plugin: ExcerptManagerPlugin;

	constructor(app: App, plugin: ExcerptManagerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		// --- Folder paths ---
		containerEl.createEl('h2', {text: 'Folders'});

		new Setting(containerEl)
			.setName('Excerpt folder')
			.setDesc('Folder where excerpt notes are stored')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.excerptFolder)
				.setValue(this.plugin.settings.excerptFolder)
				.onChange(async (value) => {
					this.plugin.settings.excerptFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Paper folder')
			.setDesc('Folder where paper/source notes are stored')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.paperFolder)
				.setValue(this.plugin.settings.paperFolder)
				.onChange(async (value) => {
					this.plugin.settings.paperFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Claim folder')
			.setDesc('Folder where claim notes are stored')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.claimFolder)
				.setValue(this.plugin.settings.claimFolder)
				.onChange(async (value) => {
					this.plugin.settings.claimFolder = value;
					await this.plugin.saveSettings();
				}));

		// --- Behaviour ---
		containerEl.createEl('h2', {text: 'Behaviour'});

		new Setting(containerEl)
			.setName('Auto-generate body')
			.setDesc('Include the selected text as a blockquote in the note body when creating an excerpt')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoGenerateBody)
				.onChange(async (value) => {
					this.plugin.settings.autoGenerateBody = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default view filter')
			.setDesc('Which excerpts to show in the sidebar by default')
			.addDropdown(drop => drop
				.addOption('current-pdf', 'Current PDF')
				.addOption('all', 'All excerpts')
				.setValue(this.plugin.settings.defaultViewFilter)
				.onChange(async (value) => {
					this.plugin.settings.defaultViewFilter = value as ExcerptManagerSettings['defaultViewFilter'];
					await this.plugin.saveSettings();
				}));

		// --- Relationship types ---
		containerEl.createEl('h2', {text: 'Relationship types'});

		const renderRelationTypes = () => {
			// Remove all relation type rows before re-rendering
			relationTypesContainer.empty();

			this.plugin.settings.relationTypes.forEach((rel: RelationType, index: number) => {
				const setting = new Setting(relationTypesContainer)
					.addText(text => text
						.setPlaceholder('name')
						.setValue(rel.name)
						.onChange(async (value) => {
							rel.name = value;
							await this.plugin.saveSettings();
						}))
					.addText(text => text
						.setPlaceholder('#rrggbb')
						.setValue(rel.color)
						.onChange(async (value) => {
							rel.color = value;
							await this.plugin.saveSettings();
						}))
					.addButton(btn => btn
						.setButtonText('Delete')
						.setWarning()
						.setDisabled(this.plugin.settings.relationTypes.length <= 1)
						.onClick(async () => {
							this.plugin.settings.relationTypes.splice(index, 1);
							await this.plugin.saveSettings();
							renderRelationTypes();
						}));
				setting.settingEl.style.alignItems = 'center';
			});
		};

		const relationTypesContainer = containerEl.createDiv();
		renderRelationTypes();

		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText('+ Add type')
				.onClick(async () => {
					this.plugin.settings.relationTypes.push({name: '', color: '#000000'});
					await this.plugin.saveSettings();
					renderRelationTypes();
				}));

		// --- RSL Cloud Sync ---
		containerEl.createEl('h2', {text: 'RSL Cloud Sync'});

		new Setting(containerEl)
			.setName('Enable RSL sync')
			.setDesc('Push/pull excerpts, papers, and relations to the RSL server on every operation')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.rslSyncEnabled)
				.onChange(async (value) => {
					this.plugin.settings.rslSyncEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('RSL API base URL')
			.setDesc('Base URL of the RSL server (no trailing slash)')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.rslBaseUrl)
				.setValue(this.plugin.settings.rslBaseUrl)
				.onChange(async (value) => {
					this.plugin.settings.rslBaseUrl = value.replace(/#.*$/, '').replace(/\/$/, '');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Check whether the RSL server is reachable')
			.addButton(btn => btn
				.setButtonText('Test')
				.onClick(async () => {
					// Always use the current URL from settings (may have just been changed)
					this.plugin.rslSync.api.baseUrl = this.plugin.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
					try {
						await this.plugin.rslSync.api.testConnection();
						new Notice('RSL: Connected ✓');
					} catch (e) {
						new Notice(`RSL: ${String(e)}`);
					}
				}));
	}
}
