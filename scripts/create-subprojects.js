#!/usr/bin/env node
// Creates GTD sub-projects under area projects and moves existing tasks into them.

const TOKEN = process.env.TODOIST_TOKEN;
if (!TOKEN) { console.error('Set TODOIST_TOKEN'); process.exit(1); }

const BASE = 'https://api.todoist.com/api/v1';

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

// ─── Parent project IDs (from fetch above) ───────────────────────────────────
const PARENTS = {
    Finance:              '6g7h6Mp7pr7jmQH9',
    Repairs:              '6g7h6MxFq2FqHC47',
    Workshop:             '6g7h6P2xcmM4pR54',
    RAV4:                 '6g7h6P64W2PmGx24',
    Garden:               '6g7h6MxVJ5pjg7qj',
    DigitalTech:          '6g7h6MMR26Q8rVVp',
    Health:               '6g7h6Mj5c6wGqmxW',
    Family:               '6g7h6Mr6vHFCPHF7',
};

// ─── Sub-projects to create ───────────────────────────────────────────────────
// Each entry: { name, parentKey, taskIds: [...task IDs to move in] }
const SUBPROJECTS = [
    // Finance
    {
        name: 'File Taxes 2025',
        parentKey: 'Finance',
        taskIds: ['6g7h6PXh8xvGJmrh'],  // File Taxes 2025
    },
    {
        name: 'Invalidity Certificate',
        parentKey: 'Finance',
        taskIds: ['6g7h6PrFF4G79PCh'],  // Invalidity Certificate — determine next step
    },
    {
        name: 'Will & Death Instructions',
        parentKey: 'Finance',
        taskIds: ['6g7h6Pp95qJRgVFh'],  // Investigate Death Instructions / Will (QC)
    },
    {
        name: 'Investment Allocation (TFSA/RRSP)',
        parentKey: 'Finance',
        taskIds: ['6g7h6Q2jj5VrHQWh'],  // Investigate investment allocation
    },

    // Repairs & Maintenance
    {
        name: 'House Cracking Investigation',
        parentKey: 'Repairs',
        taskIds: ['6g7h6Q4Hp6C2prP7'],  // Investigate house cracking
    },
    {
        name: 'Caulking Project',
        parentKey: 'Repairs',
        taskIds: ['6g7h6QRvCJg5GqJf'],  // Caulking — investigate, purchase, and caulk home
    },
    {
        name: 'Gutter Repair',
        parentKey: 'Repairs',
        taskIds: ['6g7h6Q8Rm3rFwx5f'],  // Repair gutters
    },
    {
        name: 'Workshop Wall Repair',
        parentKey: 'Repairs',
        taskIds: ['6g7h6QMfWWXR62V7'],  // Repair workshop wall
    },

    // Workshop
    {
        name: 'Design & Build Workbench',
        parentKey: 'Workshop',
        taskIds: ['6g7h6Qx3QVcHRF34'],  // Design and build workbench
    },
    {
        name: 'Organize Workshop',
        parentKey: 'Workshop',
        taskIds: ['6g7h6Qm2J75m9RmW'],  // Organize workshop
    },
    {
        name: 'Vacuum System',
        parentKey: 'Workshop',
        taskIds: ['6g7h6PPjR2wwqVfW'],  // Investigate vacuum system options
    },

    // RAV4
    {
        name: 'Brake Light Repair',
        parentKey: 'RAV4',
        taskIds: ['6g7h6RXqVgPxh2M4'],  // Investigate brake light repair
    },
    {
        name: 'AC Repair',
        parentKey: 'RAV4',
        taskIds: ['6g7h6RQM6rVJw4f4'],  // Call Radiateur Willard re: AC repair
    },

    // Garden & Exterior
    {
        name: 'Cleanup Waterways',
        parentKey: 'Garden',
        taskIds: ['6g7h6QxFhr7HMj8j'],  // Cleanup waterways backyard
    },
    {
        name: 'Remove Tree Stump',
        parentKey: 'Garden',
        taskIds: ['6g7h6RFFRq52FwMC'],  // Remove tree stump
    },

    // Digital & Tech
    {
        name: 'Photo Backup Solution',
        parentKey: 'DigitalTech',
        taskIds: ['6g7h6Rrwj922X77p'],  // Investigate photo backup solution
    },
    {
        name: 'Internet Upgrade',
        parentKey: 'DigitalTech',
        taskIds: ['6g7h6RwgjcgPgG2p'],  // Investigate internet upgrade options
    },
    {
        name: 'Organize Office',
        parentKey: 'DigitalTech',
        taskIds: ['6g7h6RgqmM4h4JwG'],  // Organize office
    },

    // Health
    {
        name: 'Toe Issue',
        parentKey: 'Health',
        taskIds: ['6g7h6PHGp8G6xrq4'],  // Book appointment re: toe issue
    },

    // Family
    {
        name: 'Kids Playground',
        parentKey: 'Family',
        taskIds: ['6g7h6V7757vWWX27'],  // Shop kids playground options
    },
];

async function main() {
    for (const sp of SUBPROJECTS) {
        const parentId = PARENTS[sp.parentKey];
        process.stdout.write(`Creating sub-project "${sp.name}"... `);
        const project = await api('POST', '/projects', {
            name: sp.name,
            parent_id: parentId,
        });
        console.log(`✅ (id: ${project.id})`);

        for (const taskId of sp.taskIds) {
            process.stdout.write(`  Moving task ${taskId} → "${sp.name}"... `);
            await api('POST', `/tasks/${taskId}/move`, { project_id: project.id });
            console.log('✅');
        }
    }
    console.log('\n🎉 All sub-projects created and tasks moved!');
}

main().catch(e => { console.error(e.message); process.exit(1); });
