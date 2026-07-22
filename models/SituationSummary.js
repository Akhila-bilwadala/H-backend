const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('SituationSummary', schema);
