import { renderPage } from "./layout";
import { FeedMap } from "./flow";

renderPage("map", <FeedMap full />, { crumbs: [{ label: "Overview", href: "/" }, { label: "Feed map" }], wide: true });
