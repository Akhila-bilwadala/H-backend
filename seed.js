require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const users = [
    {
        name: 'Admin Relief',
        phone: '9000000000',
        email: 'admin@reliefnet.org',
        role: 'admin',
        passwordHash: 'admin123',
        org: 'ReliefNet HQ',
    },
    {
        name: 'Arjun Citizen',
        phone: '9111111111',
        email: 'arjun@mail.com',
        role: 'citizen',
        passwordHash: 'citizen123',
    },
    {
        name: 'Priya Volunteer',
        phone: '9222222222',
        email: 'priya@mail.com',
        role: 'volunteer',
        passwordHash: 'volunteer123',
    },
    {
        name: 'Kerala Red Cross',
        phone: '9333333333',
        email: 'ngo@redcross.org',
        role: 'ngo',
        passwordHash: 'ngo123',
        org: 'Kerala Red Cross',
    },
];

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Clear existing users
    await User.deleteMany({});
    console.log('Cleared existing users');

    // Insert new users
    const inserted = await User.insertMany(users);
    console.log(`\n✅ Seeded ${inserted.length} users:\n`);
    inserted.forEach(u => {
        console.log(`  [${u.role.toUpperCase()}] ${u.name}`);
        console.log(`    phone: ${u.phone}  |  email: ${u.email}`);
        if (u.org) console.log(`    org:   ${u.org}`);
        console.log();
    });

    await mongoose.disconnect();
    process.exit(0);
}

seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
