const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('---Start---');

  const downloadPath = path.resolve(__dirname, 'downloads');

  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
  } else {
    await clearDownloadFolder(downloadPath);
  }

  const url =
    'https://bdif.amf-france.org/fr?rechercheTexte=D%C3%A9claration%20de%20performance%20extra%20financi%C3%A8re';

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  console.log('---Launched---');
  const page = await browser.newPage();
  console.log('---NewPageCreated---');

  // Capture les erreurs JavaScript éventuelles sur la page
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('PAGE LOG ERROR:', msg.text());
    } else {
      console.log('PAGE LOG:', msg.text());
    }
  });

  // Gérer les éventuels dialogues (alertes, confirmations, etc.)
  page.on('dialog', async (dialog) => {
    console.log(`Dialog message: ${dialog.message()}`);
    await dialog.accept();
  });

  // Configurer le chemin pour les téléchargements
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
  );

  console.log('--- Navigating to url ...');
  await page.goto(url, { waitUntil: 'networkidle2' });

  console.log('--- Waiting for selector to show ...');
  await page.waitForSelector('app-results-container');

  console.log('--- Selector div loaded ! ');

  await sleep(1000);

  // Initialisation des données
  let scrap_datas = await getScrapData(page);
  console.log('Initial scrap_datas:', scrap_datas);

  let cardTitles = await getCardTitles(page);
  console.log('Initial cardTitles:', cardTitles);

  let counter = 0;
  let currentIndex = 0; // Pointeur pour suivre l'index actuel

  while (currentIndex < scrap_datas.length) {
    const index = scrap_datas[currentIndex];
    console.log(`--- Processing card ${index + 1} ---`);

    try {
      // Cliquer sur le bouton de la carte
      await page.click(
        `app-results-container ul li:nth-child(${index + 1}) mat-card button`
      );
      console.log(`Clicked on card ${index + 1} menu button`);

      // Attendre que le menu apparaisse
      await page.waitForSelector('.mat-menu-content button:nth-child(2)', {
        visible: true,
      });
      console.log('Menu content is visible');

      await sleep(500);

      // Cliquer sur le bouton de téléchargement
      await page.click('.mat-menu-content button:nth-child(2)');
      console.log('Clicked on download button');

      // Attendre que le téléchargement commence et se termine
      const downloadedFile = await waitForDownload(downloadPath);
      
      console.log(
        `Téléchargement "${cardTitles[index]}" #${index + 1} terminé : ${downloadedFile}`
      );

      // Renommer le fichier téléchargé
      try {
        const companyName = cardTitles[index];
        const extension = path.extname(downloadedFile);
        const code = path.basename(downloadedFile, extension);
        
        // Sanitiser le nom de l'entreprise
        const sanitizedCompanyName = companyName
          .replace(/\s+/g, '_') // Remplacer les espaces par des underscores
          .replace(/[^a-zA-Z0-9_-]/g, ''); // Supprimer les caractères non valides
        
        const newFileName = `${sanitizedCompanyName}_${code}${extension}`;
        const oldPath = path.join(downloadPath, downloadedFile);
        const newPath = path.join(downloadPath, newFileName);

        await fs.promises.rename(oldPath, newPath);
        console.log(`Renamed to: ${newFileName}`);

        // Mettre à jour initialFiles avec le nouveau nom de fichier
        initialFiles.push(newFileName);
      } catch (renameError) {
        console.error(`Error renaming file ${downloadedFile}:`, renameError);
        // Vous pouvez choisir de continuer ou de lancer l'erreur selon vos besoins
      }

      counter++;
      currentIndex++; // Passer à la carte suivante

      // Vérifier si nous devons charger plus de résultats
      if (counter % 20 === 0) {
        console.log('--- 20 downloads completed, checking for "Voir plus" button ---');
        const voirPlusButton = await page.$('button.more-results');
        if (voirPlusButton) {
          await voirPlusButton.click();
          console.log('Clicked on "Voir plus" to load more results.');
          await page.waitForTimeout(3000); // Attendre que les nouveaux résultats soient chargés

          // Recharger les données après avoir cliqué sur "Voir plus"
          scrap_datas = await getScrapData(page);
          console.log('Updated scrap_datas after clicking "Voir plus":', scrap_datas);

          cardTitles = await getCardTitles(page);
          console.log('Updated cardTitles after clicking "Voir plus":', cardTitles);
        } else {
          console.log('--- "Voir plus" button not found. Finishing downloads ---');
          break; // Sortir de la boucle si "Voir plus" n'est pas trouvé
        }
      }
    } catch (error) {
      console.error(`Error processing card ${index + 1}:`, error);
      currentIndex++; // Passer à la carte suivante même en cas d'erreur
    }
  }

  await browser.close();
  console.log('--- Browser closed ---');
})();

// Fonction pour récupérer les indices des cartes
async function getScrapData(page) {
  return await page.evaluate(() => {
    const cards = document.querySelectorAll('app-results-container mat-card');
    return Array.from(cards).map((_, index) => index);
  });
}

// Fonction pour récupérer les titres des cartes
async function getCardTitles(page) {
  return await page.evaluate(() => {
    const cards = document.querySelectorAll('app-result-list-view mat-card');
    return Array.from(cards).map((card) => {
      const titleElement = card.querySelector('.card-title');
      return titleElement
        ? titleElement.textContent.trim().replace("Document d'enregistrement universel ", '')
        : null;
    });
  });
}

// Fonction pour attendre qu'un nouveau fichier soit complètement téléchargé
async function waitForDownload(downloadPath) {
  return new Promise((resolve, reject) => {
    const downloadTimeout = setTimeout(() => {
      watcher.close();
      reject(new Error('Téléchargement non terminé dans le délai imparti.'));
    }, 180000); // Augmenté à 180 secondes

    const watcher = fs.watch(downloadPath, async (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        const filePath = path.join(downloadPath, filename);
        if (!fs.existsSync(filePath)) {
          return;
        }

        // Vérifier si le fichier est complètement téléchargé
        const isDownloaded = await isFileDownloaded(filePath);
        if (isDownloaded) {
          clearTimeout(downloadTimeout);
          watcher.close();
          resolve(filename);
        }
      }
    });
  });
}

// Fonction pour vérifier si un fichier est complètement téléchargé
async function isFileDownloaded(filePath) {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
          // Le fichier n'existe pas encore
          return;
        }

        const fileSize = fs.statSync(filePath).size;
        fs.stat(filePath, (err, stats) => {
          if (err) {
            clearInterval(checkInterval);
            resolve(false);
            return;
          }

          const currentSize = stats.size;
          // Vérifier si la taille du fichier reste constante
          setTimeout(() => {
            fs.stat(filePath, (err, newStats) => {
              if (err) {
                clearInterval(checkInterval);
                resolve(false);
                return;
              }

              if (newStats.size === currentSize) {
                clearInterval(checkInterval);
                resolve(true);
              }
            });
          }, 1000);
        });
      });
    }, 1000);
  });
}

// Fonction pour mettre en pause l'exécution pendant un certain temps
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fonction pour vider le dossier de téléchargement
async function clearDownloadFolder(downloadPath) {
  return new Promise((resolve, reject) => {
    fs.readdir(downloadPath, (err, files) => {
      if (err) return reject(err);

      const unlinkPromises = files.map((file) =>
        fs.promises.unlink(path.join(downloadPath, file))
      );
      Promise.all(unlinkPromises)
        .then(() => resolve())
        .catch((err) => reject(err));
    });
  });
}
