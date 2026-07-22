const mongoose = require('mongoose');

const shelterSchema = new mongoose.Schema({
    name: { type: String, required: true },
    location: { lat: Number, lng: Number },
    totalBeds: { type: Number, default: 0 },
    occupiedBeds: { type: Number, default: 0 },
    org: String,
}, { timestamps: true });

module.exports = mongoose.model('Shelter', shelterSchema);
