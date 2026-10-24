import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import { LOGO_HOVER, LOGO_INTRO } from "./brand";
import "./custom.css";
import "./shapi-motion.css";

// The logo is inline SVG rather than an image, so the motion CSS can reach its pieces:
// the nav logo lifts the API piece on hover, the home hero plays the intro once.
const logo = (svg: string, cls: string) => () => h("span", { class: cls, innerHTML: svg });

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-title-before": logo(LOGO_HOVER, "shapi-nav-logo"),
      "home-hero-image": logo(LOGO_INTRO, "shapi-hero-logo"),
    }),
};
