// Without VitePress's own Inter: the site loads Inter Variable itself, and the bundled one would only add a
// font preload on every page that nothing uses.
import DefaultTheme from "vitepress/theme-without-fonts";
import { h } from "vue";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import { LOGO_HOVER } from "./brand";
import Home from "./components/Home.vue";
import "./custom.css";
import "./home.css";
import "./shapi-motion.css";

// The logo is inline SVG rather than an image, so the motion CSS can reach its pieces: the nav logo
// lifts the API piece on hover.
const logo = (svg: string, cls: string) => () => h("span", { class: cls, innerHTML: svg });
const INSTALL = "https://github.com/apps/shapi-by-srivarshini/installations/new";
const install = (cls: string) => () => h("a", { class: cls, href: INSTALL }, "Install on GitHub");

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-title-before": logo(LOGO_HOVER, "shapi-nav-logo"),
      "nav-bar-content-after": install("nav-install"),
      // Phones hide the nav's install pill, so the menu carries it.
      "nav-screen-content-after": install("nav-screen-install"),
    }),
  enhanceApp({ app }) {
    app.component("Home", Home);
  },
} satisfies import("vitepress").Theme;
