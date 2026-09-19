/**
 * @copresence/protocol
 *
 * The wire contract shared by the client and the server — one definition,
 * both ends fail to compile when it changes. See docs/adr/0002.
 */

export * from './constants.js';
export * from './messages.js';
export * from './codec.js';
export * from './schemas.js';
