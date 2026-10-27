import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import "@fontsource-variable/inter";
import "@fontsource-variable/jost";
import { LOGO_HOVER } from "./brand";
import Home from "./components/Home.vue";
import "./custom.css";
import "./shapi-motion.css";

// The logo is inline SVG rather than an image, so the motion CSS can reach its pieces: the nav logo
// lifts the API piece on hover.
const logo = (svg: string, cls: string) => () => h("span", { class: cls, innerHTML: svg });
const install = () =>
  h("a", { class: "nav-install", href: "https://github.com/apps/shapi-by-srivarshini/installations/new" }, "Install on GitHub");

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-title-before": logo(LOGO_HOVER, "shapi-nav-logo"),
      "nav-bar-content-after": install,
    }),
  enhanceApp({ app }) {
    app.component("Home", Home);
  },
} satisfies import("vitepress").Theme;
