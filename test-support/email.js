function emailFixture() {
    const sent = new Map();
    return { sent, configured: () => true, ready() {}, async verifyDomain() {},
        async send(message) { sent.set(message.email, message); } };
}
module.exports = { emailFixture };
