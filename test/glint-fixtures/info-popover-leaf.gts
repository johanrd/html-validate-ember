// A non-void root with a long literal open tag. A self-closing call
// substitutes to `<div popover='auto' class='…'></div>`, which is longer
// than the first line of a multi-line call.
import type { TemplateOnlyComponent } from '@ember/component/template-only';

interface InfoPopoverSig {
  Element: HTMLDivElement;
  Args: { popoverId: string; label: string };
}

const InfoPopover: TemplateOnlyComponent<InfoPopoverSig> = <template>
  <div popover='auto' id={{@popoverId}} class='m-0 w-72 rounded-xl bg-white p-4 text-sm text-gray-900' ...attributes>
    {{@label}}
  </div>
</template>;

export default InfoPopover;
