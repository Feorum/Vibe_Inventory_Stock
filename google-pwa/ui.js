// Decorative icons never replace visible, accessible navigation labels.
const paths = {
  stock:
    "M4 8h13v7a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm13 1h2a3 3 0 0 1 0 6h-2M7 3v2m4-2v2m4-2v2",
  catalog: "M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z",
  sessions: "M8 5H5v16h14V5h-3M8 3h8v4H8Zm0 9h8m-8 4h5",
  history: "M4 6a9 9 0 1 1-1 9M3 3v5h5m4-2v6l4 2",
  information:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 0a4 4 0 0 1 0 8",
  profile: "M20 21v-2a7 7 0 0 0-14 0v2M13 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
};
export function navigationLabel(button, label, active, language = "en") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "nav-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[button.dataset.view]);
  for (const [key, value] of Object.entries({
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }))
    path.setAttribute(key, value);
  svg.append(path);
  const caption = document.createElement("span");
  caption.textContent = label;
  button.replaceChildren(svg, caption);
  button.lang = language;
  button.setAttribute("aria-pressed", String(active));
  if (active) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
}

export function focusView() {
  const heading = document.querySelector("#view-heading");
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "start" });
}
