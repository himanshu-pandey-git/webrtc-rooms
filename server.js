import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT);

app.get('/', (req, res) => {
    res.send('Server is running...');
});

app.listen(PORT, () => {
    console.log(`Server is running...`);
});