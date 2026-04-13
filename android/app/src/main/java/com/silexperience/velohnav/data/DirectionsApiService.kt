package com.silexperience.velohnav.data

import com.google.gson.annotations.SerializedName
import retrofit2.http.GET
import retrofit2.http.Query

interface DirectionsApiService {
    @GET("directions/json")
    suspend fun getDirections(
        @Query("origin")      origin: String,
        @Query("destination") destination: String,
        @Query("mode")        mode: String,
        @Query("language")    language: String,
        @Query("key")         apiKey: String
    ): DirectionsResponse
}

data class DirectionsResponse(
    @SerializedName("status") val status: String,
    @SerializedName("routes") val routes: List<DirectionsRoute> = emptyList(),
    @SerializedName("error_message") val errorMessage: String? = null
)
data class DirectionsRoute(@SerializedName("legs") val legs: List<DirectionsLeg>)
data class DirectionsLeg(
    @SerializedName("distance") val distance: TextValuePair,
    @SerializedName("duration") val duration: TextValuePair,
    @SerializedName("steps")    val steps: List<DirectionsStep>
)
data class DirectionsStep(
    @SerializedName("distance")          val distance: TextValuePair,
    @SerializedName("duration")          val duration: TextValuePair,
    @SerializedName("start_location")    val startLocation: LatLngJson,
    @SerializedName("end_location")      val endLocation: LatLngJson,
    @SerializedName("html_instructions") val htmlInstructions: String,
    @SerializedName("maneuver")          val maneuver: String? = null
)
data class TextValuePair(@SerializedName("text") val text: String, @SerializedName("value") val value: Int)
data class LatLngJson(@SerializedName("lat") val lat: Double, @SerializedName("lng") val lng: Double)
