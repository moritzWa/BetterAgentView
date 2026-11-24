const views = {
  directories: {alt: "Directory grouping: 20 synthetic coding sessions across Applied Evidence, Cronus, Clipglass and BetterAgentView", description: "Group by directory. Keep company work and personal projects separate."},
  status: {alt: "The same 20 synthetic sessions grouped by Needs input and Working", description: "Ctrl S toggles status or directory grouping. Same sessions, another way to focus."},
  "work-directories": {alt: "Work-only grouping shows Applied Evidence infrastructure, platform and research, with personal projects hidden", description: "Work only hides personal projects. Those agents keep running in the background."},
};
const preview = document.getElementById("dashboard-preview");
document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    preview.src = `/launch/${view}.webp`;
    preview.alt = views[view].alt;
    document.getElementById("view-description").textContent = views[view].description;
  });
});

const tabs = [...document.querySelectorAll("[data-command]")];
function selectTab(tab, focus = false) {
  tabs.forEach(item => {
    item.setAttribute("aria-selected", String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  });
  document.getElementById("cmd").textContent = tab.dataset.command;
  document.getElementById("install-command").setAttribute("aria-labelledby", tab.id);
  document.getElementById("copy-status").textContent = "";
  document.getElementById("copy").textContent = "Copy";
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", event => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});
let copyReset;
document.getElementById("copy").addEventListener("click", async () => {
  const button = document.getElementById("copy");
  const status = document.getElementById("copy-status");
  try {
    await navigator.clipboard.writeText(document.getElementById("cmd").textContent);
    button.textContent = "Copied";
    status.textContent = "Install command copied.";
    clearTimeout(copyReset);
    copyReset = setTimeout(() => { button.textContent = "Copy"; }, 2500);
  } catch {
    status.textContent = "Couldn’t copy automatically. Select the command to copy it manually.";
  }
});
