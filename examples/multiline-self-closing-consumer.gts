// The self-closing call spans five lines. The untyped `<button>` after
// it must be reported on its own source line.
import InfoPopover from '../test/glint-fixtures/info-popover-leaf.gts';

<template>
  <section>
    <InfoPopover
      @popoverId='equipment-info-popover-for-the-selected-row'
      @label='Details about the equipment in the selected row of the table'
      class='mt-2'
    />
    <button>Save</button>
  </section>
</template>
