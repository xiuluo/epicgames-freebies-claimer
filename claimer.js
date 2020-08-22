"use strict";
const { "Launcher": EpicGames } = require("epicgames-client");
const CheckUpdate = require("check-update-github");
const ClientLoginAdapter = require("epicgames-client-login-adapter");
const Config = require(`${__dirname}/config.json`);
const Logger = require("tracer").console(`${__dirname}/logger.js`);
const Package = require("./package.json");
const TwoFactor = require("node-2fa");
const Cookie = require('tough-cookie').Cookie;

function isUpToDate() {
    return new Promise((res, rej) => {
        CheckUpdate({
            "name":           Package.name,
            "currentVersion": Package.version,
            "user":           "revadike",
            "branch":         "master"
        }, (err, latestVersion) => {
            if (err) {
                rej(err);
            } else {
                res(latestVersion === Package.version);
            }
        });
    });
}

async function freeGamesPromotions(client, country = "US", allowCountries = "US", locale = "en-US") {
    let { data } = await client.freeGamesPromotions(country, allowCountries, locale);
    let { elements } = data.Catalog.searchStore;
    let free = elements.filter(offer => offer.promotions
        && offer.promotions.promotionalOffers.length > 0
        && offer.promotions.promotionalOffers[0].promotionalOffers.find(p => p.discountSetting.discountPercentage === 0));
    let isBundle = promo => Boolean(promo.categories.find(cat => cat.path === "bundles"));
    let getOffer = promo => (isBundle(promo)
        ? client.getBundleForSlug(promo.productSlug, locale)
        : client.getProductForSlug(promo.productSlug, locale));
    let freeOffers = await Promise.all(free.map(promo => getOffer(promo)));
    return freeOffers.filter(offer => !offer.error).map(offer => ({
        "title":     offer.productName || offer._title,
        "id":        (offer.pages ? offer.pages[0] : offer).offer.id,
        "namespace": (offer.pages ? offer.pages[0] : offer).offer.namespace
    }));
}

function getChromeCookie(cookie) {
    cookie = Object.assign({}, cookie);
    cookie.name = cookie.key;
    if (cookie.expires instanceof Date) {
        cookie.expires = cookie.expires.getTime() / 1000.0;
    } else {
        delete cookie.expires;
    }
    return cookie;
}

function getToughCookie(cookie) {
    cookie = Object.assign({}, cookie);
    cookie.key = cookie.name;
    cookie.expires = new Date(cookie.expires * 1000);
    return new Cookie(cookie);
}

(async() => {
    if (!await isUpToDate()) {
        Logger.warn(`There is a new version available: ${Package.url}`);
    }

    let { accounts, options, delay, loop } = Config;
    if (!options) {
        options = {};
    }
    let sleep = delay => new Promise(res => setTimeout(res, delay * 60000));
    do {
        if (process.argv.length > 2) {
            loop = false;
            accounts = [{
                "email":               process.argv[2],
                "password":            process.argv[3],
                "rememberLastSession": Boolean(Number(process.argv[4])),
                "secret":              process.argv[5],
                "cookies":              process.argv[6],
            }];
        }

        for (let account of accounts) {
            let noSecret = !account.secret || account.secret.length === 0;
            if (!noSecret) {
                let { token } = TwoFactor.generateToken(account.secret);
                account.twoFactorCode = token;
            }

            let client = new EpicGames(account);

            if (!await client.init()) {
                throw new Error("Error while initialize process.");
            }

            if (!await client.login(account).catch(() => false)) {
                Logger.warn(`Failed to login as ${client.config.email}, please attempt manually.`);


                if (account.rememberLastSession) {
                    if (!options.cookies) {
                        options.cookies = [];
                    }
                    if (account.cookies && account.cookies.length) {
                        options.cookies = options.cookies.concat(account.cookies);
                    }
                    client.http.jar._jar.store.getAllCookies((err, cookies) => {
                        for (const cookie of cookies) {
                            options.cookies.push(getChromeCookie(cookie));
                        }
                    });
                }

                let auth = await ClientLoginAdapter.init(account, options);
                let exchangeCode = await auth.getExchangeCode();

                if (account.rememberLastSession) {
                    let cookies = await auth.getPage().then(p => p.cookies());
                    for (let cookie of cookies) {
                        cookie = getToughCookie(cookie);
                        client.http.jar.setCookie(cookie, "https://" + cookie.domain);
                    }
                }

                await auth.close();

                if (!await client.login(null, exchangeCode)) {
                    throw new Error("Error while logging in.");
                }
            }

            Logger.info(`Logged in as ${client.account.name} (${client.account.id})`);

            let { country } = client.account.country;
            let freePromos = await freeGamesPromotions(client, country, country);

            for (let offer of freePromos) {
                try {
                    let purchased = await client.purchase(offer, 1);
                    if (purchased) {
                        Logger.info(`Successfully claimed ${offer.title} (${purchased})`);
                    } else {
                        Logger.info(`${offer.title} was already claimed for this account`);
                    }
                } catch (err) {
                    Logger.warn(`Failed to claim ${offer.title} (${err})`);
                }
            }

            await client.logout();
            Logger.info(`Logged ${client.account.name} out of Epic Games`);
        }

        if (loop) {
            Logger.info(`Waiting ${delay} minutes`);
            await sleep(delay);
        } else {
            process.exit(0);
        }
    } while (loop);
})().catch(err => {
    Logger.error(err);
    process.exit(1);
});
