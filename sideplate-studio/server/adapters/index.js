// Capabilities and adapters.
//
// The studio core only knows CAPABILITIES (jobs to be done). Every tool is an
// ADAPTER that implements one or more of them. Replacing a tool means adding
// an adapter here and pointing a model at it in the registry; nothing else
// in the studio changes. Every adapter must pass tests/contract.test.js.
import manualImport from './manual-import.js';
import kaggleBundle from './kaggle-bundle.js';

export const CAPABILITIES = {
  'image.generate': {
    label: 'Generate image',
    phase: 1,
    required: ['prompt'],
    description: 'Text (plus style) to one or more images. Results become attempts in the asset history.',
  },
  'image.reference_pack': {
    label: 'Reference pack image',
    phase: 1,
    required: ['prompt', 'refImage', 'slot'],
    description: 'One view or expression of a cast winner, kept consistent with a reference image.',
  },
  'audio.clip': { label: 'Audio clip', phase: 1, required: [], description: 'An imported recording or clip.' },
  tts: { label: 'Text-to-speech', phase: 2, required: ['text'], description: 'Script line to speech in a character voice.' },
  'voice.convert': { label: 'Voice conversion', phase: 2, required: ['audio'], description: 'Your recording converted through a voice filter.' },
  'audio.effects': { label: 'Audio effects', phase: 2, required: ['audio', 'chain'], description: 'Effect-filter chain (pitch, formant, EQ...).' },
  image_to_3d: { label: 'Image to 3D', phase: 2, required: ['refImage'], description: 'A prop image to a 3D model (glTF).' },
  'render.plates': { label: 'Render set plates', phase: 2, required: ['camera'], description: 'Blender renders a plate + depth map per camera.' },
  'video.generate': { label: 'Generate video', phase: 3, required: ['prompt'], description: 'One locked shot to video.' },
  'render.timeline': { label: 'Render timeline', phase: 2, required: ['timeline'], description: 'timeline.json to a video file.' },
};

export const ADAPTERS = [manualImport, kaggleBundle];

export function getAdapter(id) {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw Object.assign(new Error(`No adapter called ${id}`), { status: 404 });
  return a;
}

export function describeAdapters() {
  return ADAPTERS.map(({ id, label, kind, capabilities, help }) => ({ id, label, kind, capabilities, help }));
}
