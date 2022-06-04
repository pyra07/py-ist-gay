/* This retrieves something from nyaa.si rss, does some verification
 and returns it as a json object */

import Parser from "rss-parser";
import {
  AnimeFormat,
  AnimeTorrent,
  AniQuery,
  Resolution,
  SearchMode,
} from "@utils/index";
import { getNumbers } from "@nyaa/utils";
import { resolution } from "profile.json";
import { findBestMatch } from "string-similarity";
import anitomy from "anitomy-js";

class Nyaa {
  private rssLink: URL;
  private parser: any;
  constructor() {
    this.rssLink = new URL("https://nyaa.si/");
    this.parser = new Parser({
      customFields: {
        item: ["nyaa:seeders"],
      },
    });
  }

  /**
   * Determines which mode to use for the search
   * @param  {AniQuery} anime
   * @param  {number} startEpisode
   * @param  {number} endEpisode
   * @param  {number[]} fsDownloadedEpisodes
   * @returns Promise
   */
  public async getTorrents(
    anime: AniQuery,
    startEpisode: number,
    endEpisode: number,
    fsDownloadedEpisodes: number[]
  ): Promise<AnimeTorrent[] | AnimeTorrent | null> {
    // Find movie/ova/ona/tv_short if they are finished
    if (
      (anime.media.format === AnimeFormat.MOVIE ||
        anime.media.format === AnimeFormat.OVA ||
        anime.media.format === AnimeFormat.ONA ||
        anime.media.format === AnimeFormat.TV_SHORT) &&
      anime.media.status === "FINISHED"
    ) {
      const animeRSS = await this.getTorrent(
        anime.media.title.romaji,
        resolution as Resolution,
        anime.media.format.toString() as SearchMode
      );
      if (animeRSS) return animeRSS;
    } else if (
      /* Find batch of episodes (TV) to download if the
      anime has already finished airing */
      anime.media.format === AnimeFormat.TV &&
      anime.media.status === "FINISHED" &&
      startEpisode === 0 &&
      fsDownloadedEpisodes.length === 0
    ) {
      const animeRSS = await this.getTorrent(
        anime.media.title.romaji,
        resolution as Resolution,
        SearchMode.BATCH,
        `${startEpisode + 1}-${endEpisode}`
      );
      if (animeRSS) return animeRSS;
      // Search for a releasing episode
    } else if (
      (anime.media.format === AnimeFormat.TV ||
        anime.media.format === AnimeFormat.TV_SHORT ||
        anime.media.format === AnimeFormat.ONA ||
        anime.media.format === AnimeFormat.OVA) &&
      anime.media.status === "RELEASING"
    ) {
      const animeTorrentList: AnimeTorrent[] = new Array();

      // Generate a list of episodes to download
      const episodeList = getNumbers(
        startEpisode,
        fsDownloadedEpisodes,
        endEpisode
      );

      // Search for episodes individually
      for (let j = 0; j < episodeList.length; j++) {
        const episode = episodeList[j];
        const episodeString =
          episodeList.length >= 100
            ? episode >= 10 && episode <= 99
              ? "0" + episode
              : episode >= 100
              ? episode.toString()
              : "00" + episode
            : episode < 10
            ? "0" + episode
            : episode.toString();

        const animeRSS = await this.getTorrent(
          anime.media.title.romaji,
          resolution as Resolution,
          SearchMode.EPISODE,
          episodeString
        );

        if (animeRSS !== null) animeTorrentList.push(animeRSS); // Check if animeRSS is not null
      }

      return animeTorrentList.length ? animeTorrentList : null;
    }
    return null;
  }

  /**
   * Query nyaa for the anime information. Then look through the RSS feed for the
   * torrent. The torrent is then verified and returned.
   * @param {string} searchQuery The title of the anime to look for
   * @param {Resolution} resolution The resolution of the video we expect
   * @param {SearchMode} searchMode What format we expect to search
   * @param {string} episodeNumber The episode number to search for, if applicable
   * @returns {Promise<AnimeTorrent>} Returns the torrent info if a match is found, otherwise returns null
   */
  private async getTorrent(
    searchQuery: string,
    resolution: Resolution,
    searchMode: SearchMode,
    episodeNumber?: string
  ): Promise<AnimeTorrent | null> {
    const finalQuery =
      searchMode === SearchMode.EPISODE
        ? `${searchQuery} - ${episodeNumber}`
        : searchQuery;

    // Set some filters, and then the search query
    this.rssLink.searchParams.set("page", "rss");
    this.rssLink.searchParams.set("q", finalQuery);
    this.rssLink.searchParams.set("c", "1_2");
    this.rssLink.searchParams.set("f", "0");

    try {
      var rss = await this.parser.parseURL(this.rssLink.href);
    } catch (error) {
      console.log(
        "An error has occured while trying to retreive the RSS feed from Nyaa:\n",
        error
      );
      return null;
    }

    if (rss.items.length === 0) return null; // Guard against empty rss

    // Sort rss.items by nyaa:seeders
    rss.items.sort((a: { [x: string]: string }, b: { [x: string]: string }) => {
      return parseInt(b["nyaa:seeders"]) - parseInt(a["nyaa:seeders"]);
    });

    /* Iterate through rss.items
    Check if the title contains mentions of both the query and resolution */
    for (const item of rss.items) {
      if (item["nyaa:seeders"] === "0") continue;

      let title: string = item.title;
      const animeParsedData = anitomy.parseSync(title);

      const isSimilar = this.verifyQuery(
        searchQuery,
        animeParsedData,
        resolution,
        searchMode,
        episodeNumber
      );

      if (isSimilar) {
        // If the title and episode are similar, and the resolution is similar, return
        item.episode = episodeNumber || "01";
        return item as AnimeTorrent;
      }
    }
    return null;
  }
  /**
   * Verifies if the query has some degree of similarity to the media to look for, based on the input given.
   * @param  {string} searchQuery The title of the anime to originally verify
   * @param  {anitomy.AnitomyResult} animeParsedData The parsed data of the RSS item title
   * @param  {Resolution} resolution The resolution to verify
   * @param  {SearchMode} searchMode What to expect from the query. This can be in multiple forms
   * @param  {string} episode? The episode number to verify, if applicable
   * @returns {boolean} Returns true if the query is similar to the media we want, otherwise returns false
   */
  private verifyQuery(
    searchQuery: string,
    animeParsedData: anitomy.AnitomyResult,
    resolution: Resolution,
    searchMode: SearchMode,
    episode?: string
  ): boolean {
    const fileName = animeParsedData.file_name;
    const parsedTitle = animeParsedData.anime_title;
    const parsedResolution = animeParsedData.video_resolution;

    if (!parsedTitle || !parsedResolution) return false; // Guard against empty parsed data

    // If parsedTitle has a title in round brackets, extract it. If found, extract the title out of the brackets
    const subAnimeTitle = parsedTitle.match(/(?<=\().+?(?=\))/);
    const subAnimeTitleString = subAnimeTitle ? subAnimeTitle[0] : "";
    const mainAnimeTitle = parsedTitle.replace(/\(.+?\)/, "");

    // if animeTitle is seperated by a '|', then split this.
    const vBarSplitTitle = parsedTitle.split("|");

    /**Attempt to find best match based on various titles procured
     * Using lowercase to avoid tampering with bestMatch rating (not important)
     */
    const titleMatch = findBestMatch(searchQuery.toLowerCase(), [
      parsedTitle.toLowerCase(),
      mainAnimeTitle.toLowerCase(),
      subAnimeTitleString.toLowerCase(),
      ...vBarSplitTitle.map((x) => x.toLowerCase()),
    ]);

    const resolutionMatch = parsedResolution.includes(resolution);

    // If title is not similar, and resolution is not similar, return false
    if (titleMatch.bestMatch.rating < 0.8) return false;
    if (!resolutionMatch) return false;

    switch (searchMode) {
      case SearchMode.EPISODE:
        const parsedEpisode = animeParsedData.episode_number;
        if (!parsedEpisode) return false; // Guard against empty episode

        const episodeMatch = parseInt(episode!) === parseInt(parsedEpisode); // Check if episode is similar

        return episodeMatch; // Return if all conditions are met

      case SearchMode.BATCH:
        const parsedReleaseInfo = animeParsedData.release_information;

        const batchMatch = parsedReleaseInfo?.includes("Batch"); // Check if it is a batch

        /* Usually some batches don't explicitly specify that the torrent itself is a
           batch. This can be combated by proving there is no episode number to be parsed
           Therefore we assume this is a batch (to be tested further) */
        const isEpisode = animeParsedData.episode_number;

        const episodeRange = fileName.match(/\d+( *)[-~]( *)\d+/); // Check if the file name contains a range of episodes
        if (episodeRange) {
          // If the file name contains a range of episodes, check if the episode is in the range
          // If so we can assume the torrent is a batch as well.
          const e = episodeRange[0].split(/[-~]/);
          const myE = episode!.split("-");
          if (
            parseInt(e[0]) === parseInt(myE[0]) &&
            parseInt(e[1]) === parseInt(myE[1])
          )
            return true; // If the range is similar, return true
          else return false; // If the range is not similar, return false
        }

        return !!(batchMatch || !isEpisode); // Return if all conditions are met.

      // For these following cases, they are only dependent on the title, and resolution.
      case SearchMode.MOVIE:

      case SearchMode.OVA:

      case SearchMode.ONA:

      case SearchMode.TV_SHORT:
        return true;

      default:
        return false;
    }
  }
}

export default new Nyaa();