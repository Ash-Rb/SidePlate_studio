// Manual import: you make the image (or clip) somewhere else, e.g. in ChatGPT,
// then drop the result into the studio. The job waits until you upload.
export default {
  id: 'manual-import',
  label: 'Manual import (ChatGPT, your own art)',
  kind: 'manual',
  capabilities: ['image.generate', 'image.reference_pack', 'audio.clip', 'tts'],
  help: 'Copy the prompt, generate in your tool of choice, then upload the result to this job.',

  // Returns the status a newly submitted job gets.
  submit(job) {
    return {
      status: 'awaiting-upload',
      instructions: job.input?.refImage
        ? 'Upload the reference image to your tool along with the prompt, then drop the result here.'
        : 'Paste the prompt into your tool, then drop the result here.',
    };
  },
};
