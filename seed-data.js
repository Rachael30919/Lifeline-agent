// Demo data: Lagos hospitals and a donor register.

const HOSPITALS = [
  { name: 'Lagos University Teaching Hospital (LUTH), Idi-Araba', short: 'LUTH', lat: 6.5170, lng: 3.3530 },
  { name: 'Lagos State University Teaching Hospital (LASUTH), Ikeja', short: 'LASUTH', lat: 6.5960, lng: 3.3460 },
  { name: 'Gbagada General Hospital', short: 'Gbagada General', lat: 6.5530, lng: 3.3880 },
  { name: 'Lagos Island General Hospital', short: 'Lagos Island General', lat: 6.4549, lng: 3.3915 },
  { name: 'Reddington Hospital, Victoria Island', short: 'Reddington VI', lat: 6.4300, lng: 3.4210 },
];

const AREAS = {
  Yaba: [6.5095, 3.3711], Surulere: [6.4969, 3.3550], Ikeja: [6.6018, 3.3515], Lekki: [6.4474, 3.4723],
  Ikoyi: [6.4520, 3.4350], Mushin: [6.5273, 3.3540], Gbagada: [6.5560, 3.3910], Ajah: [6.4670, 3.5700],
  'Victoria Island': [6.4281, 3.4219], Oshodi: [6.5560, 3.3430], Ikorodu: [6.6194, 3.5105],
  Festac: [6.4660, 3.2840], Maryland: [6.5710, 3.3670], 'Ebute-Metta': [6.4850, 3.3800], Ogba: [6.6290, 3.3400],
};

const DONORS = [
  ['Emeka Nwosu', 'O+', 'Yaba', '0803 112 4471'],
  ['Funke Adeyemi', 'O+', 'Surulere', '0806 220 1983'],
  ['Ibrahim Musa', 'O+', 'Mushin', '0812 773 0042'],
  ['Kemi Oladipo', 'O+', 'Ebute-Metta', '0705 418 2290'],
  ['Segun Alabi', 'O+', 'Ikorodu', '0809 301 5567'],
  ['Blessing Okon', 'O+', 'Ajah', '0816 990 1124'],
  ['Yusuf Garba', 'O-', 'Oshodi', '0802 556 7781'],
  ['Halima Sani', 'O-', 'Ikeja', '0813 004 6612'],
  ['Chioma Eze', 'A+', 'Ikeja', '0807 662 3319'],
  ['Femi Ogunleye', 'A+', 'Maryland', '0810 455 2208'],
  ['Zainab Lawal', 'A+', 'Ogba', '0703 118 9945'],
  ['Uche Obi', 'A-', 'Lekki', '0818 227 5530'],
  ['Tolu Bamidele', 'B+', 'Gbagada', '0805 993 1476'],
  ['Musa Danjuma', 'B+', 'Festac', '0814 300 8821'],
  ['Grace Akpan', 'B-', 'Ikoyi', '0708 641 0093'],
  ['Damilola Ajayi', 'AB+', 'Victoria Island', '0811 572 6604'],
  ['Ngozi Okeke', 'AB-', 'Surulere', '0806 019 4482'],
  ['Bayo Olatunji', 'O+', 'Gbagada', '0817 845 2276'],
].map(([name, bloodGroup, area, phone], i) => ({
  id: `D${String(i + 1).padStart(3, '0')}`, name, bloodGroup, area, phone,
  lat: AREAS[area][0], lng: AREAS[area][1],
  lastDonated: new Date(Date.now() - (60 + i * 11) * 86400000).toISOString().slice(0, 10),
}));

const SEED_REQUESTS = [
  {
    input: {
      doctor: 'Dr. Adaeze Nnamdi', patientName: 'Tunde Bakare', hospital: HOSPITALS[4].name,
      familyPhone: '0803 455 7712', need: 'CT scan (head) after road accident', bloodGroup: '', total: 120000,
    },
    payments: [['Mrs. Bakare (wife)', 50000, 'transfer'], ['Kunle Bakare (brother)', 40000, 'card'], ['Aunty Bisi', 30000, 'transfer']],
    labStart: true, labResult: 'CT report: no bleeding on the brain. Mild concussion.', labDone: true, discharge: 'code',
  },
  {
    input: {
      doctor: 'Dr. Ibrahim Yusuf', patientName: 'Ngozi Eze', hospital: HOSPITALS[1].name,
      familyPhone: '0807 220 9134', need: 'Pre-surgery labs + 1 pint of blood (appendix surgery)', bloodGroup: 'A+', total: 150000,
    },
    payments: [['Mr. Eze (father)', 60000, 'transfer'], ['Ada Eze (sister)', 30000, 'card']],
    labStart: true, labResult: 'Crossmatch compatible. Surgery successful.', labDone: true,
    discharge: { signedBy: 'Ngozi Eze', patientPhone: '0815 667 0021', weekly: 15000 },
  },
  {
    input: {
      doctor: 'Dr. Folake Martins', patientName: 'Amina Bello', hospital: HOSPITALS[2].name,
      familyPhone: '0812 600 4417', need: 'Full blood count + malaria test', bloodGroup: '', total: 25000,
    },
    payments: [],
  },
];

module.exports = { HOSPITALS, AREAS, DONORS, SEED_REQUESTS };
