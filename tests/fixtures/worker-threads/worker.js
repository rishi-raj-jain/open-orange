import workerThreads, { MessageChannel, MessagePort, isMainThread, receiveMessageOnPort } from "node:worker_threads";

export default {
	async fetch() {
		const channel = new MessageChannel();
		const received = new Promise((resolve) => {
			channel.port2.onmessage = (event) => resolve(event.data);
		});
		channel.port1.postMessage({ hello: "port" });
		const answer = {
			sameAsGlobal: MessageChannel === globalThis.MessageChannel && MessagePort === globalThis.MessagePort,
			defaultExportMatches: workerThreads.MessageChannel === MessageChannel,
			isPort: channel.port1 instanceof MessagePort,
			isMainThread,
			received: await received,
			// An Orange port would make Node's own receiveMessageOnPort() throw.
			nothingToReceive: receiveMessageOnPort(new MessageChannel().port1) === undefined,
		};
		channel.port1.close();
		return Response.json(answer);
	},
};
