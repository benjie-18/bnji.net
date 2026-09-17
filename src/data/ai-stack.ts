/**
 * BNJI.NET — pipeline diagram description (placeholder content).
 *
 * The diagram is expected to change, so it is described as data and rendered
 * by StatusPreview.astro. Updating the site should mean editing this file,
 * never editing markup.
 *
 * Content policy: neutral placeholder nodes only. This file must not describe
 * real personal hardware, a real home network, or any real credentials.
 */

export type PipelineKind = 'hardware' | 'runtime' | 'model' | 'interface' | 'agent' | 'output';

export type PipelineNode = {
	id: string;
	/** Node label, rendered in display type. */
	label: string;
	/** Mono sub-label: what it is / where it listens. */
	detail: string;
	kind: PipelineKind;
};

/** Placeholder pipeline, rendered left to right. */
export const AI_PIPELINE: PipelineNode[] = [
	{ id: 'lorem-1', label: 'Lorem', detail: 'ipsum · dolor', kind: 'hardware' },
	{ id: 'lorem-2', label: 'Sit', detail: 'amet · consectetur', kind: 'runtime' },
	{ id: 'lorem-3', label: 'Adipiscing', detail: 'elit · sed do', kind: 'model' },
	{ id: 'lorem-4', label: 'Eiusmod', detail: 'tempor · incididunt', kind: 'interface' },
	{ id: 'lorem-5', label: 'Ut labore', detail: 'et dolore · magna', kind: 'agent' },
	{ id: 'lorem-6', label: 'Aliqua', detail: 'ut enim · minim', kind: 'output' },
];

/** Mono key/value facts rendered beside the pipeline. */
export const AI_STACK_FACTS: { label: string; value: string }[] = [
	{ label: 'Lorem', value: 'Ipsum dolor sit amet, consectetur adipiscing elit' },
	{ label: 'Sed do', value: 'Eiusmod tempor incididunt ut labore et dolore' },
	{ label: 'Magna', value: 'Aliqua ut enim ad minim veniam quis nostrud' },
	{ label: 'Exercitation', value: 'Ullamco laboris nisi ut aliquip ex ea commodo' },
];

/** Note rendered next to the diagram so placeholders read as placeholders. */
export const AI_STACK_NOTE =
	'Placeholder diagram: lorem ipsum nodes stand in for a real pipeline description.';

/** Placeholder workflow narrative, rendered as a numbered list. */
export const WORKFLOW_STEPS: string[] = [
	'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
	'Sed do eiusmod tempor incididunt ut labore et dolore.',
	'Magna aliqua ut enim ad minim veniam quis nostrud.',
	'Excepteur sint occaecat cupidatat non proident sunt.',
];
