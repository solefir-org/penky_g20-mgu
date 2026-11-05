'use strict';

const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const url = require('url');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const RS = String.fromCharCode(0x1e);

function readDns(dataDir) {
    try {
        const lease = JSON.parse(fs.readFileSync(path.join(dataDir, 'uplink.json'), 'utf8'));
        if (lease && Array.isArray(lease.dns) && lease.dns.length) dns.setServers(lease.dns);
    } catch (e) { /* uplink is offline or not installed */ }
}

function request(address, method, body, timeout, onRequest) {
    return new Promise((resolve, reject) => {
        const parsed = url.parse(address);
        const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
        if (!transport || !parsed.hostname) return reject(new Error('Address must start with http:// or https://'));
        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || undefined,
            method,
            path: (parsed.pathname || '/') + (parsed.search || ''),
            headers: body == null ? {} : {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        if (onRequest) onRequest(req);
        req.on('error', reject);
        if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('Server request timed out')));
        if (body != null) req.write(body);
        req.end();
    });
}

class LongPolling extends EventEmitter {
    constructor(serverUrl, dataDir) {
        super();
        this.serverUrl = serverUrl.replace(/\/$/, '');
        this.dataDir = dataDir;
        this.pending = Object.create(null);
        this.activeRequests = [];
        this.nextId = 0;
        this.running = false;
        this.connected = false;
    }

    _url(suffix) {
        return this.serverUrl + suffix;
    }

    _request(address, method, body, timeout) {
        let req;
        const remove = () => {
            const index = this.activeRequests.indexOf(req);
            if (index >= 0) this.activeRequests.splice(index, 1);
        };
        return request(address, method, body, timeout, (created) => {
            req = created;
            this.activeRequests.push(req);
        }).then((result) => { remove(); return result; }, (error) => { remove(); throw error; });
    }

    async connect() {
        if (this.running) return;
        this.running = true;
        readDns(this.dataDir);
        try {
            const response = await this._request(this._url('/negotiate?negotiateVersion=1'), 'POST', '', 15000);
            if (response.status < 200 || response.status >= 300) throw new Error('Negotiate failed: HTTP ' + response.status);
            const info = JSON.parse(response.body);
            if (!info.connectionToken && !info.connectionId) throw new Error('Server did not return a connection token');
            this.connectionId = info.connectionToken || info.connectionId;
            const pollAddress = this._url('?id=' + encodeURIComponent(this.connectionId));
            const firstPoll = this._request(pollAddress, 'GET', null, 100000);
            await this._request(pollAddress, 'POST', JSON.stringify({ protocol: 'json', version: 1 }) + RS, 15000);
            const handshake = await firstPoll;
            if (handshake.status < 200 || handshake.status >= 300) throw new Error('Handshake failed: HTTP ' + handshake.status);
            this._messages(handshake.body);
            this.connected = true;
            this.emit('connected');
            while (this.running) {
                const result = await this._request(pollAddress, 'GET', null, 100000);
                if (result.status === 204) break;
                if (result.status < 200 || result.status >= 300) throw new Error('Long Polling failed: HTTP ' + result.status);
                if (result.body) this._messages(result.body);
            }
            if (this.running) throw new Error('Long Polling ended unexpectedly');
        } catch (error) {
            this.connected = false;
            this.running = false;
            this.emit('disconnected', error);
            throw error;
        }
    }

    _messages(text) {
        text.split(RS).forEach((frame) => {
            if (!frame) return;
            const message = JSON.parse(frame);
            if (message.error) throw new Error(message.error);
            if (message.type === 1) this.emit(message.target, ...(message.arguments || []));
            else if (message.type === 3) {
                const pending = this.pending[message.invocationId];
                if (!pending) return;
                delete this.pending[message.invocationId];
                if (message.error) pending.reject(new Error(message.error));
                else pending.resolve(message.result);
            }
        });
    }

    invoke(method) {
        const args = Array.prototype.slice.call(arguments, 1);
        if (!this.connected) return Promise.reject(new Error('Not connected to the server'));
        const id = String(++this.nextId);
        const message = JSON.stringify({ type: 1, invocationId: id, target: method, arguments: args }) + RS;
        return new Promise((resolve, reject) => {
            this.pending[id] = { resolve, reject };
            this._request(this._url('?id=' + encodeURIComponent(this.connectionId)), 'POST', message, 15000)
                .then((response) => {
                    if (response.status < 200 || response.status >= 300) throw new Error('Send failed: HTTP ' + response.status);
                })
                .catch((error) => {
                    delete this.pending[id];
                    reject(error);
                });
        });
    }

    close() {
        this.running = false;
        this.connected = false;
        this.activeRequests.slice().forEach((req) => req.destroy());
        Object.keys(this.pending).forEach((id) => {
            this.pending[id].reject(new Error('Connection closed'));
            delete this.pending[id];
        });
    }
}

module.exports = { LongPolling, request, readDns };