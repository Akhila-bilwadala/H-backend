const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
    org: { type: String }, // optional for now
    item: { type: String, required: true },
    unitsInStock: { type: Number, default: 0 },
    unitsRequestedToday: { type: Number, default: 0 },
    forecastHoursLeft: { type: Number, default: null },
    updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Inventory', inventorySchema);
