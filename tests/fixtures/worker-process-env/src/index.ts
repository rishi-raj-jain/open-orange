import nodeProcess from "node:process";

export default {
	fetch(): Response {
		return Response.json({
			bare: { ...process.env },
			imported: { ...nodeProcess.env },
			global: { ...globalThis.process.env },
			sameProcess: globalThis.process === nodeProcess && process === nodeProcess,
		});
	},
};
