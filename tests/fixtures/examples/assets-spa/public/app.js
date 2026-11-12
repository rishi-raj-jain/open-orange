// A tiny client-side router. Every path loads this page, so the script
// decides what to show.
const page = document.querySelector("#page");
const api = document.querySelector("#api");

function render() {
	page.textContent = location.pathname === "/" ? "Home" : `Page: ${location.pathname}`;
}

document.addEventListener("click", (event) => {
	const link = event.target.closest("a");
	if (link === null || link.origin !== location.origin) return;
	event.preventDefault();
	history.pushState(null, "", link.href);
	render();
});
addEventListener("popstate", render);
render();

const response = await fetch("/api/hello");
api.textContent = (await response.json()).message;
