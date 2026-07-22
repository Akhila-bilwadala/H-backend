const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: { type: String }, // optional if imported from phone
    phone: { type: String, required: true, unique: true },
    email: String,
    role: { type: String, enum: ['citizen', 'volunteer', 'admin', 'ngo'], default: 'citizen' },
    passwordHash: String,
    org: String,
    resources: [{ type: String }],
    currentLocation: { lat: Number, lng: Number },
    available: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    tasksCompleted: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
