const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
    description: { type: String, required: true },
    translatedText: String,
    category: String,
    urgency: { type: String, enum: ['Low', 'Medium', 'High', 'Critical'], default: 'Low' },
    priorityScore: { type: Number, default: 0 },
    peopleAffected: { type: Number, default: 1 },
    location: {
        lat: Number,
        lng: Number,
        address: String
    },
    photoUrl: String,
    damageSeverity: { type: String, enum: ['Low', 'Medium', 'High'] },
    phone: String,
    status: { type: String, enum: ['pending', 'assigned', 'rejected_reassigning', 'enroute', 'done'], default: 'pending' },
    isDuplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Request' },
    assignedVolunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionHistory: [{
        volunteer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reason: String,
        at: { type: Date, default: Date.now }
    }],
    statusHistory: [{
        status: String,
        at: { type: Date, default: Date.now }
    }],
}, { timestamps: true });

module.exports = mongoose.model('Request', requestSchema);
