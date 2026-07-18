To run scraper.py

git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
docker build -t tor-scraper ./Scraper
docker run --rm -it -v ./output:/tmp/scraped_pages tor-scraper