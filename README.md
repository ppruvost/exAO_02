# exAO — Enregistrement, traitement frame-by-frame et ajustement linéaire

Ce projet frontend (100% web) permet de :
- enregistrer une vidéo depuis une webcam (MediaRecorder) ou charger un fichier vidéo,
- traiter la vidéo frame-by-frame (utilise `requestVideoFrameCallback` quand disponible) pour détecter une balle verte et une balle rose,
- convertir pixels → mètres via calibrage avec deux points d'échelle,
- calculer la position en fonction du temps, la vitesse (différences finies),
- estimer l'accélération par régression contrainte `v = a * t` et afficher la valeur théorique `a = 9.8 * sin(alpha)`,
- tracer la droite d'ajustement libre `v = a * t + b`, afficher son équation et le R²,
- exporter les données au format CSV.

## Fichiers
- `index.html` — page principale
- `style.css` — styles
- `script.js` — logique d'enregistrement, traitement et affichage
- `README.md` — ce fichier

## Utilisation
1. Ouvrir `index.html` dans un navigateur moderne (Chrome/Edge/Firefox).
2. Autoriser l'accès à la caméra.
3. (Optionnel) Entrer la distance d'étalonnage (m) et cliquer `Étalonner`, puis cliquer deux points connus dans la vidéo.
4. Démarrer l'enregistrement, puis l'arrêter (ou charger un fichier vidéo).
5. Cliquer `Traiter la vidéo enregistrée`.
6. Après traitement, visualiser les graphiques et la droite d'ajustement. Exporter les données en CSV si besoin.

## Remarques
- Pour une précision temporelle en centièmes de seconde, il faut une caméra fournissant suffisamment de fps (idéalement 100 fps).
- Le code de détection couleur est simple (HSV) et fonctionne mieux en conditions contrôlées. Pour plus de robustesse, intégrer OpenCV.js.

