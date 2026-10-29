// tsc cannot read single-file components; this lets the theme import them. Their script blocks are not
// type-checked, so logic worth checking lives in .ts files (theme/dates.ts).
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
