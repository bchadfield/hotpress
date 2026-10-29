// Progressive enhancement: the place list works without JS; this adds a filter box.
const list = document.querySelector<HTMLUListElement>("[data-filter-list]");
if (list) {
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Filter places";
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    for (const li of list.querySelectorAll("li")) li.hidden = !li.textContent!.toLowerCase().includes(q);
  });
  list.before(input);
}
