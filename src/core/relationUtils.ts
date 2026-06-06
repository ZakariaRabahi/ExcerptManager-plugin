import ExcerptManagerPlugin from '../main';

// Visually distinct palette for auto-assigned relation type colors.
// Each new custom type gets the next unused palette color; once
// the palette is exhausted we fall back to HSL golden-ratio rotation.
const PALETTE = [
	'#2196F3', // blue
	'#FF9800', // orange
	'#9C27B0', // purple
	'#00BCD4', // cyan
	'#FF5722', // deep-orange
	'#607D8B', // blue-grey
	'#E91E63', // pink
	'#3F51B5', // indigo
	'#8BC34A', // light-green
	'#FFC107', // amber
	'#009688', // teal
	'#795548', // brown
	'#673AB7', // deep-purple
];

/**
 * Ensures a relation type with `name` exists in settings.
 * If it is new, picks the next unused palette color (or generates one via
 * HSL golden-ratio rotation) and persists the update.
 * Returns the color (existing or newly assigned).
 */
export async function ensureRelationType(
	plugin: ExcerptManagerPlugin,
	name: string,
): Promise<string> {
	const existing = plugin.settings.relationTypes.find(rt => rt.name === name);
	if (existing) return existing.color;

	const usedColors = new Set(plugin.settings.relationTypes.map(rt => rt.color));
	const available  = PALETTE.filter(c => !usedColors.has(c));

	const color: string = available.length > 0 && available[0] !== undefined
		? available[0]
		: `hsl(${Math.round((plugin.settings.relationTypes.length * 137.508) % 360)},65%,45%)`;

	plugin.settings.relationTypes.push({name, color});
	await plugin.saveSettings();
	return color;
}
