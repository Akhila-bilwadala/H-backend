require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const Request = require('./models/Request');
const Inventory = require('./models/Inventory');
const Shelter = require('./models/Shelter');
const User = require('./models/User');
const SituationSummary = require('./models/SituationSummary');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'mock');
const genModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
if (process.env.MONGO_URI) {
    mongoose.connect(process.env.MONGO_URI)
        .then(() => console.log('MongoDB Hooked Up!'))
        .catch(err => console.error('MongoDB connection error:', err));
} else {
    console.log('No MONGO_URI set — running with mock data only');
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    const { email, phone, role } = req.body;
    let userRole = role === 'Admin' ? 'admin' : 'volunteer';
    let userEmail = email || phone;

    // Seed a mock volunteer so auto-assignment has a target
    if (mongoose.connection.readyState === 1 && userRole === 'volunteer') {
        const exists = await User.findOne({ email: userEmail });
        if (!exists) {
            await User.create({
                name: 'Demo Volunteer',
                email: userEmail,
                phone: phone || '9876543210',
                role: 'volunteer',
                currentLocation: { lat: 9.5, lng: 76.3 },
                available: true,
                resources: ['medical', 'rescue', 'food', 'shelter']
            });
            console.log('Seeded demo volunteer');
        }
    }

    return res.json({
        success: true,
        token: 'MOCK_JWT_TOKEN',
        user: { role: userRole, email: userEmail, uid: 'demo_volunteer_1' } // Provide consistent UID for demo mode
    });
});

// ─── REQUESTS ────────────────────────────────────────────────────────────────
// POST /api/requests/submit — citizen submits a request
app.post('/api/requests/submit', async (req, res) => {
    try {
        const { description, phone, peopleAffected, location, photoUrl } = req.body;

        // Default analysis in case AI fails
        let aiAnalysis = {
            category: 'other',
            urgency: 'Medium',
            priorityScore: 50,
            translatedText: description,
            summary: description.slice(0, 100),
            damageSeverity: undefined
        };

        try {
            const prompt = `You are a disaster relief triage AI. Analyze the following citizen request and return ONLY a valid JSON object with exactly these fields:
{
  "translatedText": "<English translation of the input, or same text if already English>",
  "category": "<one of: medical, rescue, food, shelter, water, clothing, other>",
  "urgency": "<one of: Low, Medium, High, Critical>",
  "peopleAffected": <Integer of people affected based on description, default to 1 if unknown>,
  "resourceNeeded": "<brief resource needed, e.g. Insulin, Boat, Food Kits>",
  "summary": "<one concise sentence summary in English>",
  "vulnerabilityKeywords": ["<list any: elderly, child, pregnant, disabled, infant if mentioned>"]
}

Citizen request: "${description}"
Return ONLY the JSON object, no explanation, no markdown formatting.`;
            const result = await genModel.generateContent(prompt);
            let raw = result.response.text().trim();
            if (raw.startsWith("\`\`\`")) raw = raw.split("\`\`\`")[1].replace(/^json/, "");
            const aiData = JSON.parse(raw.trim());

            const urgencyScore = { "Critical": 80, "High": 60, "Medium": 40, "Low": 20 }[aiData.urgency || "Medium"] || 40;
            const vulnerabilities = (aiData.vulnerabilityKeywords || []).length;
            const vulnScore = vulnerabilities > 0 ? 10 : 0;
            const people = Math.min(10, aiData.peopleAffected || 1);
            const pScore = Math.min(100, urgencyScore + vulnScore + people);

            aiAnalysis = {
                category: aiData.category || aiAnalysis.category,
                urgency: aiData.urgency || aiAnalysis.urgency,
                priorityScore: pScore,
                translatedText: aiData.translatedText || aiAnalysis.translatedText,
                summary: aiData.summary || aiAnalysis.summary,
                damageSeverity: undefined
            };
        } catch (aiErr) {
            console.warn('AI classification failed, using fallback:', aiErr.message);
        }

        // Duplicate Detection (Phase 3)
        let isDuplicateOf = null;
        if (mongoose.connection.readyState === 1 && location?.lat && location?.lng) {
            try {
                const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
                // ~1km bounding box
                const latDelta = 0.01;
                const lngDelta = 0.01;

                const recentReqs = await Request.find({
                    createdAt: { $gte: threeHoursAgo },
                    'location.lat': { $gte: location.lat - latDelta, $lte: location.lat + latDelta },
                    'location.lng': { $gte: location.lng - lngDelta, $lte: location.lng + lngDelta }
                }).lean();

                if (recentReqs.length > 0) {
                    const prompt = `Given this new emergency request: "${description}"
And these recent requests in the same geographic radius:
${JSON.stringify(recentReqs.map(r => ({ id: r._id.toString(), description: r.description })))}

Does the new request definitively represent the EXACT SAME physical event/emergency as any of the recent ones? 
Return ONLY a valid JSON object: { "isDuplicate": boolean, "duplicateOf": "<id of the duplicate or null>" }`;
                    const dupResult = await genModel.generateContent(prompt);
                    let raw = dupResult.response.text().trim();
                    if (raw.startsWith("\`\`\`")) raw = raw.split("\`\`\`")[1].replace(/^json/, "");
                    const dupData = JSON.parse(raw.trim());
                    if (dupData.isDuplicate && dupData.duplicateOf) {
                        isDuplicateOf = dupData.duplicateOf;
                        console.log(`Flagged as duplicate of ${isDuplicateOf}`);
                    }
                }
            } catch (err) {
                console.warn('Duplicate check failed:', err.message);
            }
        }

        const doc = new Request({
            description,
            phone,
            peopleAffected: peopleAffected || 1,
            location,
            photoUrl,
            isDuplicateOf,
            statusHistory: [{ status: 'pending', at: new Date() }],
            ...aiAnalysis,
        });

        if (mongoose.connection.readyState === 1) {
            await doc.save();

            // AUTO-ASSIGNMENT LOGIC (Nearest Volunteer)
            try {
                if (!isDuplicateOf && location?.lat && location?.lng) {
                    const resource = (aiAnalysis.category || 'general').toLowerCase();
                    const volunteers = await User.find({ role: 'volunteer', available: true }).lean();
                    if (volunteers.length > 0) {
                        const R = 6371; // km
                        const scoredVols = volunteers.map(v => {
                            let dist = 999;
                            if (v.currentLocation?.lat) {
                                const dLat = (location.lat - v.currentLocation.lat) * Math.PI / 180;
                                const dLon = (location.lng - v.currentLocation.lng) * Math.PI / 180;
                                const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(v.currentLocation.lat * Math.PI / 180) * Math.cos(location.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                                dist = R * c;
                            }
                            const hasRes = v.resources?.some(r => r.toLowerCase().includes(resource));
                            const score = (dist * 0.6) - (hasRes ? 40 : 0);
                            return { ...v, dist, matchScore: score };
                        }).sort((a, b) => a.matchScore - b.matchScore);

                        const bestMatch = scoredVols[0];
                        if (bestMatch && bestMatch.dist < 50) { // arbitrary 50km radius limit
                            doc.status = 'assigned';
                            doc.assignedVolunteer = bestMatch._id;
                            doc.statusHistory.push({ status: 'assigned', at: new Date() });
                            await doc.save();
                            console.log(`Auto-assigned to volunteer ${bestMatch.email || bestMatch.phone}`);
                        }
                    }
                }
            } catch (autoErr) {
                console.error('Auto-assignment failed:', autoErr.message);
            }
        }

        return res.json({ success: true, message: 'Request submitted', request: doc });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/requests  — admin fetches sorted queue
app.get('/api/requests', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const { sort, status } = req.query;
            let query = {};
            if (status) query.status = status;

            let sortObj = { createdAt: -1 };
            if (sort === 'priorityScore' || !sort) sortObj = { priorityScore: -1 };

            const requests = await Request.find(query).sort(sortObj).lean();
            return res.json(requests);
        }
        // Fallback mock data
        return res.json([
            { _id: '1', description: 'Need insulin for grandmother, running out tonight.', category: 'medical', urgency: 'Critical', priorityScore: 92, status: 'pending', peopleAffected: 1, location: { lat: 9.5, lng: 76.3 } },
            { _id: '2', description: 'Family of 4 stranded on rooftop, water rising.', category: 'rescue', urgency: 'High', priorityScore: 80, status: 'pending', peopleAffected: 4, location: { lat: 9.6, lng: 76.4 } },
            { _id: '3', description: 'Requesting dry food and water for six people.', category: 'food', urgency: 'Medium', priorityScore: 55, status: 'pending', peopleAffected: 6, location: { lat: 9.4, lng: 76.5 } },
            { _id: '4', description: 'Shelter needed, current location flooded.', category: 'shelter', urgency: 'Medium', priorityScore: 50, status: 'pending', peopleAffected: 2, location: { lat: 9.3, lng: 76.2 } },
        ]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /api/requests/:id/status  — volunteer updates status (accept/enroute/done)
app.patch('/api/requests/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const valid = ['assigned', 'enroute', 'done'];
        if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        if (mongoose.connection.readyState === 1) {
            const reqDoc = await Request.findById(req.params.id);
            if (!reqDoc) return res.status(404).json({ error: 'Not found' });

            reqDoc.status = status;
            reqDoc.statusHistory.push({ status, at: new Date() });
            await reqDoc.save();

            // Volunteer availability toggle
            if (reqDoc.assignedVolunteer) {
                if (status === 'enroute') {
                    await User.findByIdAndUpdate(reqDoc.assignedVolunteer, { available: false });
                } else if (status === 'done') {
                    await User.findByIdAndUpdate(reqDoc.assignedVolunteer, { available: true, $inc: { tasksCompleted: 1 } });
                }
            }

            // Twilio mock send
            console.log(`[Twilio Mock] SMS to ${reqDoc.phone || 'Citizen'}: Your request status is now ${status}`);

            return res.json({ success: true, request: reqDoc });
        }
        return res.json({ success: true, message: 'Mock status update OK' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// POST /api/requests/:id/reject — volunteer rejects task -> auto-reassigns
app.post('/api/requests/:id/reject', async (req, res) => {
    try {
        const { volunteerId, reason } = req.body;
        if (mongoose.connection.readyState === 1) {
            const reqDoc = await Request.findById(req.params.id);
            if (!reqDoc) return res.status(404).json({ error: 'Not found' });

            reqDoc.rejectionHistory.push({ volunteer: volunteerId, reason, at: new Date() });
            reqDoc.assignedVolunteer = null;
            reqDoc.status = 'rejected_reassigning';
            reqDoc.statusHistory.push({ status: 'rejected_reassigning', at: new Date() });

            await reqDoc.save();

            // Auto-reassign loop
            const resource = (reqDoc.category || 'general').toLowerCase();
            const rejectedIds = reqDoc.rejectionHistory.map(r => r.volunteer.toString());

            let volunteers = await User.find({ role: 'volunteer', available: true, _id: { $nin: rejectedIds } }).lean();
            if (volunteers.length > 0) {
                // Find next best
                const R = 6371;
                volunteers = volunteers.map(v => {
                    let dist = 999;
                    if (v.currentLocation?.lat && reqDoc.location?.lat) {
                        const dLat = (reqDoc.location.lat - v.currentLocation.lat) * Math.PI / 180;
                        const dLon = (reqDoc.location.lng - v.currentLocation.lng) * Math.PI / 180;
                        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(v.currentLocation.lat * Math.PI / 180) * Math.cos(reqDoc.location.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                        dist = R * c;
                    }
                    const hasRes = v.resources?.some(r => r.toLowerCase().includes(resource));
                    return { ...v, matchScore: (dist * 0.6) - (hasRes ? 40 : 0) };
                });
                volunteers.sort((a, b) => a.matchScore - b.matchScore);

                // Assign best
                const nextBest = volunteers[0];
                reqDoc.assignedVolunteer = nextBest._id;
                reqDoc.status = 'assigned';
                reqDoc.statusHistory.push({ status: 'assigned', at: new Date() });
                await reqDoc.save();
                console.log(`Auto-reassigned to ${nextBest.name || nextBest.email}`);
            }

            return res.json({ success: true, request: reqDoc });
        }
        return res.json({ success: true, message: 'Mock reject OK' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// GET /api/volunteers/tasks/:email  — volunteer fetches their assigned works
app.get('/api/volunteers/tasks/:email', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            // Find user by email
            const vOpt = await User.findOne({ email: req.params.email, role: 'volunteer' }).lean();
            if (vOpt) {
                const myTasks = await Request.find({ assignedVolunteer: vOpt._id }).sort({ createdAt: -1 }).lean();
                return res.json(myTasks);
            }
        }
        return res.json([]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});


// GET /api/requests/:id/matches
app.get('/api/requests/:id/matches', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) return res.json([]);
        const request = await Request.findById(req.params.id);
        if (!request) return res.status(404).json({ error: 'Not found' });

        const resource = (request.category || 'general').toLowerCase();
        let volunteers = await User.find({ role: 'volunteer', available: true }).lean();

        let usingGoogle = false;

        if (process.env.GOOGLE_DISTANCE_MATRIX_KEY && request.location?.lat) {
            // Batch process using Google Distance Matrix
            const origins = volunteers.filter(v => v.currentLocation?.lat).map(v => `${v.currentLocation.lat},${v.currentLocation.lng}`).join('|');
            if (origins) {
                try {
                    const matrixUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${request.location.lat},${request.location.lng}&key=${process.env.GOOGLE_DISTANCE_MATRIX_KEY}`;
                    const distRes = await fetch(matrixUrl);
                    if (distRes.ok) {
                        const distData = await distRes.json();
                        if (distData.status === 'OK') {
                            usingGoogle = true;
                            let idx = 0;
                            volunteers = volunteers.map(v => {
                                if (v.currentLocation?.lat) {
                                    const element = distData.rows[idx]?.elements[0];
                                    idx++;
                                    let dist = 999;
                                    let duration = 9999;
                                    if (element && element.status === 'OK') {
                                        dist = element.distance.value / 1000; // to km
                                        duration = element.duration.value;
                                    }
                                    const hasRes = v.resources?.some(r => r.toLowerCase().includes(resource));
                                    const score = (dist * 0.6) - (hasRes ? 40 : 0);
                                    return { ...v, dist, duration, hasResource: hasRes, matchScore: score };
                                }
                                return { ...v, matchScore: 9999 };
                            });
                        }
                    }
                } catch (e) {
                    console.error("Google Matrix failed:", e.message);
                }
            }
        }

        if (!usingGoogle) {
            // Haversine fallback MVP
            const R = 6371; // km
            volunteers = volunteers.map(v => {
                let dist = 999;
                if (v.currentLocation?.lat && request.location?.lat) {
                    const dLat = (request.location.lat - v.currentLocation.lat) * Math.PI / 180;
                    const dLon = (request.location.lng - v.currentLocation.lng) * Math.PI / 180;
                    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(v.currentLocation.lat * Math.PI / 180) * Math.cos(request.location.lat * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    dist = R * c;
                }
                const hasRes = v.resources?.some(r => r.toLowerCase().includes(resource));
                const score = (dist * 0.6) - (hasRes ? 40 : 0);
                return { ...v, dist, hasResource: hasRes, matchScore: score };
            });
        }

        volunteers.sort((a, b) => a.matchScore - b.matchScore);
        return res.json(volunteers.slice(0, 3));
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// PATCH /api/requests/:id/assign  — admin dispatches a volunteer
app.patch('/api/requests/:id/assign', async (req, res) => {
    try {
        const { volunteerId } = req.body;
        if (mongoose.connection.readyState === 1) {
            const doc = await Request.findByIdAndUpdate(
                req.params.id,
                { $set: { status: 'assigned', assignedVolunteer: volunteerId }, $push: { statusHistory: { status: 'assigned', at: new Date() } } },
                { new: true }
            );
            return res.json({ success: true, request: doc });
        }
        return res.json({ success: true, message: 'Mock assign OK' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────
app.get('/api/inventory/alerts', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const items = await Inventory.find({ forecastHoursLeft: { $lt: 6 } }).lean();
            return res.json(items);
        }
        return res.json([]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/inventory', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const items = await Inventory.find().lean();
            return res.json(items);
        }
        // Fallback mock data
        return res.json([
            { _id: '1', org: 'Aksharam Relief', item: 'Insulin / Medicine', unitsInStock: 120, unitsRequestedToday: 48, forecastHoursLeft: 2 },
            { _id: '2', org: 'Aksharam Relief', item: 'Drinking water', unitsInStock: 600, unitsRequestedToday: 65, forecastHoursLeft: 18 },
            { _id: '3', org: 'Aksharam Relief', item: 'Food kits', unitsInStock: 400, unitsRequestedToday: 72, forecastHoursLeft: 6 },
            { _id: '4', org: 'Aksharam Relief', item: 'Blankets', unitsInStock: 300, unitsRequestedToday: 14, forecastHoursLeft: 48 },
        ]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventory', async (req, res) => {
    try {
        const item = new Inventory(req.body);
        if (mongoose.connection.readyState === 1) await item.save();
        return res.json({ success: true, item });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── VOLUNTEERS ────────────────────────────────────────────────────────────────
app.get('/api/volunteers', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const vols = await User.find({ role: 'volunteer', available: true }).lean();
            return res.json(vols);
        }
        return res.json([
            { _id: 'v1', userId: 'u1', skills: ['medical', 'food'], hasVehicle: true, available: true, currentLocation: { lat: 9.52, lng: 76.32 } },
            { _id: 'v2', userId: 'u2', skills: ['rescue', 'shelter'], hasVehicle: false, available: true, currentLocation: { lat: 9.61, lng: 76.41 } },
        ]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/volunteers/tasks/:userId', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const tasks = await Request.find({ assignedVolunteer: req.params.userId }).sort({ priorityScore: -1 }).lean();
            return res.json(tasks);
        }
        return res.json([]);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/summary/latest', async (req, res) => {
    try {
        if (mongoose.connection.readyState === 1) {
            const summary = await SituationSummary.findOne().sort({ createdAt: -1 }).lean();
            if (summary) return res.json(summary);
        }
        return res.json({ content: 'Waiting for AI processing...' });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Background AI summary task (every 5 minutes)
setInterval(async () => {
    if (mongoose.connection.readyState === 1) {
        try {
            const requests = await Request.find({ status: 'pending' }).select('description urgency category').limit(50).lean();
            const lowInventory = await Inventory.find({ forecastHoursLeft: { $lt: 24 } }).select('item forecastHoursLeft unitsInStock').lean();

            const prompt = `You are a disaster relief coordination AI briefing authorities. Based on the active requests and inventory, write a concise 3-5 bullet point situation report. Mention hotspot areas, critical resource shortages, and recommended immediate actions.
  Active requests:
  ${JSON.stringify(requests)}

  Inventory:
  ${JSON.stringify(lowInventory)}

  Write ONLY the bullet points, no preamble.`;
            const result = await genModel.generateContent(prompt);
            await SituationSummary.create({ content: result.response.text().trim() });
            console.log('Background task: new situation summary generated.');
        } catch (e) {
            console.warn('Background summary task failed:', e.message);
        }
    }
}, 300000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});
