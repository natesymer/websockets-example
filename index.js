const express = require('express');
const asyncHandler = require('express-async-handler');

class WebsocketRegistry {
	constructor() {
		this._map = {};
	}

	// This function ensures our data structure is sane before we use it.
	_ensure(owner, key) {
		if (!owner) throw new Error("owner is falsey");
		if (!key) throw new Error('key is falsey');
		// ensure this._map is properly formed
		if (!this._map[owner]) this._map[owner] = {};
		if (!this._map[owner][key]) this._map[owner][key] = [];
	}

	/**
	 * Sends a message to all websockets belonging to a user
	 * that match a given `key`.
 	 * @param {any} owner A user ID, UUID, etc
	 * @param {any} key Preferrably a string or int, used to organize websockets based on what kind of data they expect/work with.
	 * @param {string} data The data to send.
	 * @param {function} onData Called when the websocket gets a message. Takes one parameter, the message string. Optional.
	 */
	add(owner, key, ws, onData = null) {
		this._ensure(owner, key);

		// store the websocket
		let el = {ws, onData};
		this._map[owner][key].push(el);

		// removes the socket (by reference)
		// from this._map
		const removeSocket = () => this._map[owner][key] = this._map[owner][key].filter(x => x !== el);

		// ensure that the websocket is removed from the data structure when its closed.
		ws.addEventListener('close', (code, reason) => {
			removeSocket();
		});

		// if we get an error on the websocket, bail.
		ws.addEventListener('error', (error) => {
			removeSocket();
		});

		// Call our onData function
		ws.addEventListener('message', e => {
			if (onData) {
				onData(e.data);
			}
		});
	}

	/**
	 * Sends a message to all websockets belonging to a user
	 * that match a given `key`.
 	 * @param {any} owner A user ID, UUID, etc
	 * @param {any} key Preferrably a string or int, used to organize websockets based on what kind of data they expect/work with.
	 * @param {string} data The data to send.
	 * @param {object} options Options to be passed to WebSocket.send()
	 */
	send(owner, key, data, options = {}) {
		this._ensure(owner, key);
		return new Promise((resolve, reject) => {
			let wses = this._map[owner][key];
			let promises = [];
			for (const {ws} of wses) {
				promises.push(new Promise((_resolve, _reject) => {
					ws.send(data, options, function(err) {
						if (err) {
							_reject(err);
						} else {
							_resolve();
						}
					});
				}));
			}
			Promise.all(promises).then(resolve);
		});
	}

	// Link send, but sends to all websockets for all owners,
	// given a websocket type/key specificied in the `key` param.
	sendAll(key, data, options = {}) {
		return Promise.all(Object.keys(this._map).map(owner => this.send(owner, key, data, options)));
	}
}

global.websockets = new WebsocketRegistry();

const app = express();
const expressWs = require('express-ws')(app);

app.use(express.urlencoded({extended: true}));

app.get('/', asyncHandler(async (req, res) => {
	const {user_id, recipient} = req.query;
	const html = `
<html>
	<body>
		<p>
			Click <a href="/?user_id=a&recipient=b">this link</a> and then <a target="_blank" href="/?user_id=b&recipient=a">this link</a>.<br /><br />

			The "Send Message" form uses websockets to transmit the message to the server (to be sent to a specific user via webhook), whereas the "broadcast message" form uses an HTTP POST request to post the message to the backend, which in turn uses websockets to forward the message to all browsers' connected websockets.<br /><br />

			Messages will appear below the forms.
		</p>
		<div>
			<label for="recipient_message">Send Message</label>
			<input id="recipient_message">
			<label for="owner">Recipient</label>
			<input value="${recipient ?? "b"}" type="text" id="owner" placeholder="Enter recipient identifier">
			<button id="recipient_btn">Send</button>
		</div>
		<div>
			<label for="broadcast_message">Broadcast Message</label>
			<input id="broadcast_message">
			<button id="broadcast_btn">Broadcast</button>
		</div>
		<div id="root"></div>
		<script type="application/javascript">
			const user_id = "${user_id ?? 'a'}";
			const r = document.getElementById('root');
			const o = document.getElementById('owner');
			const bm = document.getElementById('broadcast_message');
			const rm = document.getElementById('recipient_message');
			const bb = document.getElementById('broadcast_btn');

			let ws = new WebSocket('ws://localhost:3000/websocket/messaging?user_id=' + user_id);

			function onMessage({message, from}) {
				const prefix = from ? from + ": " : "<BROADCAST> ";
				let p = document.createElement('p');
				p.innerHTML = prefix + message;
				r.appendChild(p);
			}

			ws.addEventListener('message', e => {
				onMessage(JSON.parse(e.data));
			});

			function sendMessage(message, recipient) {
				onMessage({message, from: user_id});
				ws.send(JSON.stringify({message, recipient}));
			}

			document.getElementById("recipient_btn").addEventListener('click', () => {
				sendMessage(rm.value, o.value);
				rm.value = '';
			});

			document.getElementById("broadcast_btn").addEventListener('click', () => {
				const message = bm.value;
				bm.value = '';
				fetch('/broadcast', {
					body: "message=" + encodeURIComponent(message),
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					method: "post"
				});
			});
		</script>
	</body>
</html>
	`;
	res.send(html);
}));

app.post('/broadcast', asyncHandler(async (req, res) => {
	const {message} = req.body;
	global.websockets.sendAll("messaging", JSON.stringify({message}));
}));

app.ws('/websocket/:key', asyncHandler(async (ws, req) => {
	const {user_id} = req.query;
	const {key} = req.params;
	global.websockets.add(user_id, key, ws, data => {
		const {recipient, message} = JSON.parse(data);
		global.websockets.send(recipient, key, JSON.stringify({message, from: user_id}));
	});
}));

app.listen(3000);
