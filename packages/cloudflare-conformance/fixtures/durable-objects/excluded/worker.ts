import { DurableObject } from "cloudflare:workers";

export class ExcludedDurableObject extends DurableObject {
	async excludedSurface(): Promise<object> {
		return {
			container: this.ctx.container,
			exports: this.ctx.exports,
			facets: this.ctx.facets,
			props: this.ctx.props,
			currentBookmark: await this.ctx.storage.getCurrentBookmark(),
			bookmarkForTime: await this.ctx.storage.getBookmarkForTime(new Date()),
			nextBookmark:
				await this.ctx.storage.onNextSessionRestoreBookmark("bookmark"),
		};
	}

	connect(_socket: Socket): void {}
}
